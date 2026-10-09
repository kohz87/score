import type { DatabaseSync } from 'node:sqlite'
import { AgentIdSchema, type AgentSummary, type Message, type NowSnapshot } from '@score/contract'
import { z } from 'zod'
import { ApprovalRowSchema, approvalView } from './approval-store.ts'
import { buildLanes, type LaneTaskInput } from './lanes.ts'
import { pathFromPreview } from './room-panels.ts'
import { messageFromRow } from './rooms.ts'
import { projectedTasks } from './tasks.ts'
import { PAUSED_HEADLINE, teamPausedAt } from './team-pause.ts'

// Read model for Now › Score, computed on request from the projections the ingest path already stored.
const MADE_TODAY_LIMIT = 5
const FILES_PER_TASK = 8
const EDIT_TOOL = /(^|[_.\-:])(edit|editor|patch|write|create|append|str_replace)([_.\-:]|$)/i
const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
]

const RunRowSchema = z.object({
  id: z.string(),
  profile: z.string(),
  status: z.string(),
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
})
const HopRowSchema = z.object({
  message_id: z.string(),
  run_id: z.string().nullable(),
  from_agent_id: z.string().nullable(),
  parent_run_id: z.string().nullable(),
  agent_id: z.string(),
  created_at: z.iso.datetime(),
  // The brief behind the turn has tasks or a plan, so its runs are brief work rather than plain chat.
  brief_work: z.union([z.literal(0), z.literal(1)]),
})
const ToolRowSchema = z.object({ tool: z.string(), preview: z.string().nullable() })

function count(n: number): string {
  const word = WORDS[n] ?? String(n)
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export function headlineText(working: number, needsYou: number, paused = false): string {
  const first = paused
    ? PAUSED_HEADLINE
    : working === 0
      ? 'Nobody is working.'
      : working === 1
        ? 'One agent is working.'
        : `${count(working)} agents are working.`
  const second =
    needsYou === 0
      ? 'Nothing needs you.'
      : needsYou === 1
        ? 'One thing needs you.'
        : `${count(needsYou)} things need you.`
  return `${first} ${second}`
}

export interface NowOptions {
  from: string
  to: string
  now: number
  agents: AgentSummary[]
  disabled: readonly string[]
  root?: string
}

export function readNow(sqlite: DatabaseSync, options: NowOptions): Omit<NowSnapshot, 'asOfSeq'> {
  const { from, to, now, agents, disabled, root = process.cwd() } = options
  const nowIso = new Date(now).toISOString()
  const tasks = projectedTasks(sqlite, now)
  const runTask = new Map<string, string>()
  for (const task of tasks) for (const runId of task.runIds) runTask.set(runId, task.id)

  const runs = z.array(RunRowSchema).parse(
    sqlite
      .prepare(
        `SELECT id, profile, status, started_at, ended_at FROM runs
          WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at, id`,
      )
      .all(to, from),
  )
  const hops = z.array(HopRowSchema).parse(
    sqlite
      .prepare(
        // Only hops into runs in the window can be drawn; this keeps the read bounded as history grows.
        `SELECT message_id, run_id, from_agent_id, agent_id, created_at,
                (SELECT p.run_id FROM message_runs p WHERE p.message_id = message_runs.parent_message_id) AS parent_run_id,
                (plan_first = 1
                  OR EXISTS (SELECT 1 FROM brief_tasks b WHERE b.brief_id = message_runs.chain_id)
                  OR EXISTS (SELECT 1 FROM brief_plan_starts s WHERE s.brief_id = message_runs.chain_id)) AS brief_work
           FROM message_runs
          WHERE run_id IN (SELECT id FROM runs WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?))
          ORDER BY created_at, message_id`,
      )
      .all(to, from),
  )
  const pending = z.array(ApprovalRowSchema).parse(
    sqlite
      .prepare(
        `SELECT * FROM approvals WHERE visible = 1 AND phase = 'human_pending' AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, id`,
      )
      .all(nowIso),
  )
  const views = pending.map((row) => approvalView(sqlite, row, { now, disabled }))
  const focus = views.find((approval) => approval.actionable) ?? null
  const needsYou = views.filter((approval) => approval.actionable).length

  const laneTasks: LaneTaskInput[] = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    assignee: task.assignee,
    reviewer: task.reviewer,
    column: task.column,
  }))
  // A run answering a chat message is a brief's work when the brief has tasks or a plan, else a plain chat reply.
  const chatRuns = new Map(
    hops.flatMap((hop) =>
      hop.run_id === null ? [] : [[hop.run_id, hop.brief_work === 1 ? 'brief' : 'chat'] as const],
    ),
  )
  const built = buildLanes({
    agentIds: agents.map((agent) => agent.id),
    runs: runs.map((run) => ({
      id: run.id,
      agentId: run.profile,
      status: run.status,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      taskId: runTask.get(run.id) ?? null,
      kind: chatRuns.get(run.id) ?? 'task',
    })),
    tasks: laneTasks,
    hops: hops.map((hop) => ({
      id: hop.message_id,
      runId: hop.run_id,
      fromAgentId: hop.from_agent_id,
      parentRunId: hop.parent_run_id,
      agentId: hop.agent_id,
      at: hop.created_at,
    })),
    waitingRunIds: pending.flatMap((row) => (row.run_id ? [row.run_id] : [])),
    from,
    to,
    now: nowIso,
  })
  const working = built.lanes.filter((lane) =>
    lane.blocks.some((block) => block.state === 'working' && block.end === null),
  ).length

  const latest = sqlite
    .prepare(
      'SELECT room_id FROM messages WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1',
    )
    .get()
  const thread = latest
    ? (() => {
        const roomId = z.object({ room_id: z.string() }).parse(latest).room_id
        const messages: Message[] = sqlite
          .prepare(
            'SELECT * FROM messages WHERE room_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 3',
          )
          .all(roomId)
          .map(messageFromRow)
          .reverse()
        return { roomId, messages }
      })()
    : null

  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const runStatement = sqlite.prepare(
    'SELECT id, profile, status, started_at, ended_at FROM runs WHERE id = ?',
  )
  const runById = {
    get: (id: string) => RunRowSchema.optional().parse(runStatement.get(id)),
  }
  const madeToday = tasks
    .map((task) => ({ task, doneAt: Date.parse(task.completedAt ?? task.updatedAt) }))
    .filter(({ task, doneAt }) => isDone(task) && doneAt >= midnight.getTime())
    .sort((a, b) => b.doneAt - a.doneAt)
    .map(({ task }) => task)
    .slice(0, MADE_TODAY_LIMIT)
    .map((task) => {
      const paths = new Set<string>()
      for (const runId of task.runIds) {
        const tools = z
          .array(ToolRowSchema)
          .parse(
            sqlite
              .prepare('SELECT tool, preview FROM tool_calls WHERE run_id = ? ORDER BY seq')
              .all(runId),
          )
        for (const tool of tools) {
          if (!EDIT_TOOL.test(tool.tool)) continue
          const path = pathFromPreview(tool.preview, root)
          if (path !== null) paths.add(path)
        }
      }
      // A reviewer run that ended normally is not a passed review: Hermes closes a "changes requested" review
      // as a normal completion too. Pass only when the task is done and nobody else resumed work after the run.
      const taskRuns = task.runIds.flatMap((runId) => {
        const run = runById.get(runId)
        return run ? [run] : []
      })
      const checks = task.reviewer
        ? taskRuns.flatMap((run) => {
            const agentId = AgentIdSchema.safeParse(run.profile)
            if (!agentId.success || run.profile !== task.reviewer || !isFinished(run.status))
              return []
            const sentBack = taskRuns.some(
              (other) =>
                other.profile !== task.reviewer &&
                Date.parse(other.started_at) > Date.parse(run.started_at),
            )
            return [
              {
                label: `Review of ${task.title}`,
                agentId: agentId.data,
                ok: run.status === 'completed' && isDone(task) && !sentBack,
              },
            ]
          })
        : []
      return {
        title: task.title,
        ref: { kind: 'task' as const, taskId: task.id },
        // The bridge records no line counts, so these stay 0 until a source for them exists.
        files: [...paths].slice(0, FILES_PER_TASK).map((path) => ({ path, added: 0, removed: 0 })),
        checks,
      }
    })

  return {
    now: nowIso,
    paused: teamPausedAt(sqlite) !== null,
    headline: {
      working,
      needsYou,
      text: headlineText(working, needsYou, teamPausedAt(sqlite) !== null),
    },
    lanes: built.lanes.map((lane) => ({
      agent: agents.find((agent) => agent.id === lane.agentId)!,
      blocks: lane.blocks,
    })),
    handoffs: built.handoffs,
    focusApproval: focus,
    thread,
    madeToday,
  }
}

// A stray approval flips a finished task's card back to needs_you, so look at its stored status too.
function isDone({ column, hermesStatus }: { column: string; hermesStatus: string }): boolean {
  return column === 'done' || hermesStatus === 'done'
}

function isFinished(status: string): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
}
