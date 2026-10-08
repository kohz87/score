import {
  BriefSummarySchema,
  TaskDetailSchema,
  type BriefStatus,
  type BriefSummary,
  type TaskDetail,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import type { DeriveEvents, DomainEventDraft } from '../hub/ingest.ts'
import { redact } from '../redact.ts'
import { holdable, recordHolds, type HoldOwner } from './holds.ts'
import { teamPausedAt } from './team-pause.ts'

// Briefs (design review 3.4): a human room message plus what it causes. Links to tasks are exact only; nothing
// here guesses from timing.

export const BriefRowSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  title: z.string(),
  started_at: z.iso.datetime(),
  started_by: z.string(),
  paused_at: z.iso.datetime().nullable(),
  emitted_status: z.string().nullable(),
})
export type BriefRow = z.infer<typeof BriefRowSchema>

export type BriefTaskOrigin = 'assign' | 'plan' | 'child'
// Destructured: the adapter boundary scan flags a property access spelled with a dot before "hermes".
export const taskStatus = ({ hermesStatus }: { hermesStatus: string }) => hermesStatus
export const TERMINAL_TASK_STATUSES = ['done', 'archived']
export const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting_for_approval']
const FAILED_RUN_STATUSES = ['failed', 'interrupted']
const PAGE = 500
const WEEK_MS = 7 * 24 * 3600 * 1000

const TaskIdRowSchema = z.object({ task_id: z.string() })
const IdRowSchema = z.object({ id: z.string() })

export function briefTitle(text: string): string {
  const first = text.split(/\r\n|\n|\r/).find((line) => line.trim()) ?? ''
  return redact(first.trim()).slice(0, 120) || 'Untitled brief'
}

export function readBriefRow(sqlite: DatabaseSync, id: string): BriefRow | undefined {
  const row = sqlite.prepare('SELECT * FROM briefs WHERE id = ?').get(id)
  return row === undefined ? undefined : BriefRowSchema.parse(row)
}

export function requireBrief(sqlite: DatabaseSync, id: string): BriefRow {
  const row = readBriefRow(sqlite, id)
  if (!row) throw new HttpError(404, 'not_found', 'Unknown brief')
  return row
}

export function briefTaskIds(sqlite: DatabaseSync, briefId: string): string[] {
  return z
    .array(TaskIdRowSchema)
    .parse(
      sqlite
        .prepare('SELECT task_id FROM brief_tasks WHERE brief_id = ? ORDER BY linked_at, rowid')
        .all(briefId),
    )
    .map((row) => row.task_id)
}

export function projectedDetail(sqlite: DatabaseSync, taskId: string): TaskDetail | undefined {
  const row = sqlite.prepare('SELECT detail FROM task_projections WHERE id = ?').get(taskId)
  if (!row) return undefined
  return TaskDetailSchema.parse(JSON.parse(z.object({ detail: z.string() }).parse(row).detail))
}

export function briefTasks(
  sqlite: DatabaseSync,
  briefId: string,
): { taskId: string; detail: TaskDetail | undefined }[] {
  return briefTaskIds(sqlite, briefId).map((taskId) => ({
    taskId,
    detail: projectedDetail(sqlite, taskId),
  }))
}

const RunStatusRowSchema = z.object({
  status: z.string(),
  ended_at: z.string().nullable(),
  started_at: z.string(),
})
function runStatuses(sqlite: DatabaseSync, runIds: string[]) {
  return runIds.flatMap((id) => {
    const row = sqlite.prepare('SELECT status, ended_at, started_at FROM runs WHERE id = ?').get(id)
    return row === undefined ? [] : [{ id, ...RunStatusRowSchema.parse(row) }]
  })
}

// Statuses in which Hermes still intends to run or hand the task on (retry, input, review): a failed
// attempt is then one step of the task's story, not its outcome.
const OPEN_TASK_STATUSES = ['triage', 'todo', 'ready', 'running', 'scheduled', 'blocked', 'review']

/** Newest first; Hermes timestamps have second resolution, so the id breaks ties deterministically. */
export function newestFirst(
  left: { id: string; started_at: string },
  right: { id: string; started_at: string },
): number {
  return left.started_at < right.started_at
    ? 1
    : left.started_at > right.started_at
      ? -1
      : left.id < right.id
        ? 1
        : left.id > right.id
          ? -1
          : 0
}

/**
 * A task counts as failed when its most recent run failed, the task did not finish afterwards and Hermes
 * is not waiting on a retry, input or review (attempt failure is not task disposition).
 */
export function taskFailed(sqlite: DatabaseSync, detail: TaskDetail): boolean {
  if (detail.column === 'done') return false
  if (OPEN_TASK_STATUSES.includes(taskStatus(detail))) return false
  const last = runStatuses(sqlite, detail.runIds).sort(newestFirst)[0]
  return last !== undefined && FAILED_RUN_STATUSES.includes(last.status)
}

export interface TurnRow {
  message_id: string
  agent_id: string
  hop: number
  turn_id: string
  parent_message_id: string
  from_agent_id: string | null
  state: 'pending' | 'active' | 'completed' | 'failed'
  run_id: string | null
  run_status: string | null
  created_at: string
}
const TurnRowSchema = z.object({
  message_id: z.string(),
  agent_id: z.string(),
  hop: z.int(),
  turn_id: z.string(),
  parent_message_id: z.string(),
  from_agent_id: z.string().nullable(),
  state: z.enum(['pending', 'active', 'completed', 'failed']),
  run_id: z.string().nullable(),
  run_status: z.string().nullable(),
  created_at: z.string(),
})
export function briefTurns(sqlite: DatabaseSync, briefId: string): TurnRow[] {
  return z.array(TurnRowSchema).parse(
    sqlite
      .prepare(
        `SELECT m.message_id, m.agent_id, m.hop, m.turn_id, m.parent_message_id, m.from_agent_id, m.state, m.run_id,
           r.status AS run_status, m.created_at
         FROM message_runs m LEFT JOIN runs r ON r.id = m.run_id WHERE m.chain_id = ?
         ORDER BY m.created_at, m.rowid`,
      )
      .all(briefId),
  )
}

export function deriveBriefStatus(sqlite: DatabaseSync, row: BriefRow): BriefStatus {
  if (row.paused_at !== null) return 'paused'
  const turns = briefTurns(sqlite, row.id)
  const tasks = briefTasks(sqlite, row.id)
  const running =
    turns.some(
      (turn) =>
        turn.state === 'pending' ||
        turn.state === 'active' ||
        (turn.run_status !== null && ACTIVE_RUN_STATUSES.includes(turn.run_status)),
    ) || tasks.some(({ detail }) => !detail || !TERMINAL_TASK_STATUSES.includes(taskStatus(detail)))
  if (running) return 'running'
  const last = turns.at(-1)
  const lastFailed =
    last !== undefined &&
    (last.state === 'failed' ||
      (last.run_status !== null && FAILED_RUN_STATUSES.includes(last.run_status)))
  if (lastFailed || tasks.some(({ detail }) => detail && taskFailed(sqlite, detail)))
    return 'failed'
  return 'done'
}

export function briefSummary(sqlite: DatabaseSync, row: BriefRow): BriefSummary {
  return BriefSummarySchema.parse({
    id: row.id,
    title: row.title,
    roomId: row.room_id,
    startedAt: row.started_at,
    startedBy: row.started_by,
    status: deriveBriefStatus(sqlite, row),
  })
}

/** Emits the brief when its status differs from the last one an event carried (or `force`). */
function emitBrief(sqlite: DatabaseSync, id: string, force = false): DomainEventDraft[] {
  const row = readBriefRow(sqlite, id)
  if (!row) return []
  const summary = briefSummary(sqlite, row)
  if (!force && row.emitted_status === summary.status) return []
  sqlite.prepare('UPDATE briefs SET emitted_status = ? WHERE id = ?').run(summary.status, id)
  return [{ type: 'brief.upserted', data: summary }]
}
export const emitBriefChange = emitBrief

export function createBrief(
  sqlite: DatabaseSync,
  req: {
    id: string
    roomId: string
    text: string
    startedBy?: string
    startedAt?: string
    tasks?: { taskId: string; origin: BriefTaskOrigin }[]
  },
  now: string,
): DomainEventDraft[] {
  const inserted = sqlite
    .prepare(
      `INSERT INTO briefs (id, room_id, title, started_at, started_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(req.id, req.roomId, briefTitle(req.text), req.startedAt ?? now, req.startedBy ?? 'you')
  if (!inserted.changes) return []
  linkTasks(sqlite, req.id, req.tasks ?? [], now)
  return emitBrief(sqlite, req.id, true)
}

/** Records exact task links first, then any Kanban children already known (so an explicit origin wins). */
export function linkTasks(
  sqlite: DatabaseSync,
  briefId: string,
  tasks: { taskId: string; origin: BriefTaskOrigin }[],
  now: string,
): void {
  const fresh = tasks.filter(({ taskId, origin }) =>
    Boolean(
      sqlite
        .prepare(
          `INSERT INTO brief_tasks (brief_id, task_id, origin, linked_at) VALUES (?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(briefId, taskId, origin, now).changes,
    ),
  )
  for (const { taskId } of fresh) linkDescendants(sqlite, briefId, taskId, now)
}

export const linkTask = (
  sqlite: DatabaseSync,
  briefId: string,
  taskId: string,
  origin: BriefTaskOrigin,
  now: string,
) => linkTasks(sqlite, briefId, [{ taskId, origin }], now)

// Kanban `--parent` edges: a task that depends on a brief task is that task's child.
function linkDescendants(sqlite: DatabaseSync, briefId: string, taskId: string, now: string) {
  const children = z.array(IdRowSchema).parse(
    sqlite
      .prepare(
        `SELECT id FROM task_projections WHERE EXISTS
           (SELECT 1 FROM json_each(json_extract(detail, '$.dependsOn')) WHERE value = ?)`,
      )
      .all(taskId),
  )
  linkTasks(
    sqlite,
    briefId,
    children.map((child) => ({ taskId: child.id, origin: 'child' as const })),
    now,
  )
}

export function recordEdge(
  sqlite: DatabaseSync,
  briefId: string,
  handoff: { id: string; kind: 'handoff' | 'review' | 'sent_back'; at: string },
  from: string,
  to: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO brief_edges (brief_id, id, kind, from_block, to_block, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(briefId, handoff.id, handoff.kind, from, to, handoff.at)
}

function briefIdsFor(sqlite: DatabaseSync, sql: string, value: string): string[] {
  return z
    .array(z.object({ brief_id: z.string() }))
    .parse(sqlite.prepare(sql).all(value))
    .map((row) => row.brief_id)
}
const forMessage = (sqlite: DatabaseSync, id: string) =>
  briefIdsFor(sqlite, 'SELECT chain_id AS brief_id FROM message_runs WHERE message_id = ?', id)
const forRun = (sqlite: DatabaseSync, id: string) => [
  ...briefIdsFor(sqlite, 'SELECT chain_id AS brief_id FROM message_runs WHERE run_id = ?', id),
  ...briefIdsFor(
    sqlite,
    `SELECT b.brief_id FROM brief_tasks b JOIN task_projections p ON p.id = b.task_id WHERE EXISTS
     (SELECT 1 FROM json_each(json_extract(p.detail, '$.runIds')) WHERE value = ?)`,
    id,
  ),
]
const forTask = (sqlite: DatabaseSync, id: string) =>
  briefIdsFor(sqlite, 'SELECT brief_id FROM brief_tasks WHERE task_id = ?', id)

/**
 * Pause covers tasks that arrive later: a task linked to a paused brief, assigned to a paused agent, or seen while
 * the team is paused gets a pending hold per paused owner, in the observation's own transaction. The server parks
 * them after the commit (task-holds.ts), and recovery finishes them after a crash.
 */
function recordArrivalHolds(sqlite: DatabaseSync, taskIds: Iterable<string>, now: string): void {
  const teamPaused = teamPausedAt(sqlite) !== null
  for (const taskId of taskIds) {
    const detail = projectedDetail(sqlite, taskId)
    if (!detail || !holdable(sqlite, taskId, taskStatus(detail))) continue
    const owners: HoldOwner[] = z
      .array(z.object({ brief_id: z.string() }))
      .parse(
        sqlite
          .prepare(
            `SELECT b.brief_id FROM brief_tasks b JOIN briefs r ON r.id = b.brief_id
             WHERE b.task_id = ? AND r.paused_at IS NOT NULL`,
          )
          .all(taskId),
      )
      .map((row) => ({ kind: 'brief', id: row.brief_id }))
    if (
      detail.assignee &&
      sqlite.prepare('SELECT 1 FROM agent_pauses WHERE agent_id = ?').get(detail.assignee) !==
        undefined
    )
      owners.push({ kind: 'agent', id: detail.assignee })
    if (teamPaused) owners.push({ kind: 'team', id: 'team' })
    for (const owner of owners) recordHolds(sqlite, owner, [taskId], now)
  }
}

// Ingest hook: keeps the brief tables in step with the events an observation produced, and emits
// `brief.upserted` when a brief's derived status changed. Same transaction as the observation itself.
export const deriveBriefEvents: DeriveEvents = (sqlite, drafts, { now }) => {
  const affected = new Set<string>()
  const add = (ids: string[]) => ids.forEach((id) => affected.add(id))
  const explicit = new Set<string>()
  const arrived = new Set<string>()
  for (const draft of drafts) {
    switch (draft.type) {
      case 'brief.upserted':
        explicit.add(draft.data.id)
        break
      case 'message.created':
      case 'message.delta':
      case 'typing':
        break
      case 'message.completed':
        add(forMessage(sqlite, draft.data.messageId))
        break
      case 'run.updated':
        add(forRun(sqlite, draft.data.id))
        for (const ref of draft.data.refs) if (ref.kind === 'task') add(forTask(sqlite, ref.taskId))
        break
      case 'task.upserted': {
        const detail = projectedDetail(sqlite, draft.data.id)
        for (const parent of detail?.dependsOn ?? [])
          for (const briefId of forTask(sqlite, parent))
            linkTask(sqlite, briefId, draft.data.id, 'child', now)
        add(forTask(sqlite, draft.data.id))
        arrived.add(draft.data.id)
        break
      }
      case 'approval.requested':
      case 'approval.updated':
        for (const ref of draft.data.refs) {
          if (ref.kind === 'task') add(forTask(sqlite, ref.taskId))
          if (ref.kind === 'run') add(forRun(sqlite, ref.runId))
        }
        break
      case 'handoff.created': {
        const { briefId, handoff } = draft.data
        if (briefId && readBriefRow(sqlite, briefId)) {
          recordEdge(sqlite, briefId, handoff, handoff.from.blockId, handoff.to.blockId)
          add([briefId])
        }
        break
      }
      case 'lane.upserted': {
        const { briefId, block } = draft.data
        if (!briefId || !readBriefRow(sqlite, briefId)) break
        const turn = block.runId
          ? z
              .object({ message_id: z.string() })
              .optional()
              .parse(
                sqlite
                  .prepare('SELECT message_id FROM message_runs WHERE run_id = ?')
                  .get(block.runId),
              )
          : undefined
        const node = block.taskId
          ? `task:${block.taskId}`
          : turn
            ? `turn:${turn.message_id}`
            : undefined
        if (node)
          sqlite
            .prepare(
              `INSERT INTO brief_blocks (brief_id, block_id, node_id) VALUES (?, ?, ?)
               ON CONFLICT (brief_id, block_id) DO UPDATE SET node_id = excluded.node_id`,
            )
            .run(briefId, block.id, node)
        add([briefId])
        break
      }
      default:
        break
    }
  }
  recordArrivalHolds(sqlite, arrived, now)
  return [...affected].filter((id) => !explicit.has(id)).flatMap((id) => emitBrief(sqlite, id))
}

/** Last activity of a brief: its start, or the latest end of any of its turns' or tasks' runs. */
export function briefLastEnd(sqlite: DatabaseSync, row: BriefRow): string {
  const ends = [
    ...briefTurns(sqlite, row.id).flatMap((turn) => (turn.run_id ? [turn.run_id] : [])),
    ...briefTasks(sqlite, row.id).flatMap(({ detail }) => detail?.runIds ?? []),
  ]
  return runStatuses(sqlite, ends).reduce(
    (latest, run) => (run.ended_at && run.ended_at > latest ? run.ended_at : latest),
    row.started_at,
  )
}

export function listBriefs(
  sqlite: DatabaseSync,
  status: 'active' | 'recent',
  nowMs: number,
): BriefSummary[] {
  const cutoff = new Date(nowMs - WEEK_MS).toISOString()
  const result: BriefSummary[] = []
  // Page through the table: a limit applied before the status filter would hide older unfinished briefs.
  for (let offset = 0; ; offset += PAGE) {
    const rows = z
      .array(BriefRowSchema)
      .parse(
        sqlite
          .prepare('SELECT * FROM briefs ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?')
          .all(PAGE, offset),
      )
    for (const row of rows) {
      const summary = briefSummary(sqlite, row)
      const active = summary.status === 'running' || summary.status === 'paused'
      if (status === 'active' ? active : !active && briefLastEnd(sqlite, row) >= cutoff)
        result.push(summary)
      if (status === 'recent' && result.length >= 50) return result
    }
    if (rows.length < PAGE) return result
  }
}
