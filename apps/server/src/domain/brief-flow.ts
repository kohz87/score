import {
  BriefLogPageSchema,
  FlowNodeDetailSchema,
  RunSummarySchema,
  type BriefFlow,
  type BriefLogPage,
  type BriefSummary,
  type FlowEdge,
  type FlowNode,
  type FlowNodeDetail,
  type LogLine,
  type RunSummary,
  type TaskDetail,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import { redact } from '../redact.ts'
import { ApprovalRowSchema, approvalView } from './approval-store.ts'
import {
  ACTIVE_RUN_STATUSES,
  briefSummary,
  briefTasks,
  briefTurns,
  requireBrief,
  taskFailed,
  type BriefRow,
  type TurnRow,
} from './briefs.ts'
import { messageFromRow } from './rooms.ts'
import { taskWithApproval } from './tasks.ts'

export const MAX_FLOW_NODES = 200

const FAILED_RUN = ['failed', 'interrupted']
const EdgeRowSchema = z.object({
  id: z.string(),
  kind: z.enum(['handoff', 'review', 'sent_back']),
  from_block: z.string(),
  to_block: z.string(),
  at: z.string(),
})
const BlockRowSchema = z.object({ block_id: z.string(), node_id: z.string() })

function replyText(sqlite: DatabaseSync, messageId: string): string {
  const row = sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(messageId)
  if (!row) return ''
  const text = messageFromRow(row)
    .parts.filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('\n')
  return (
    text
      .split(/\r\n|\n|\r/)
      .find((line) => line.trim())
      ?.trim() ?? ''
  )
}

function turnNode(sqlite: DatabaseSync, turn: TurnRow): FlowNode {
  const failed =
    turn.state === 'failed' || (turn.run_status !== null && FAILED_RUN.includes(turn.run_status))
  const state: FlowNode['state'] = failed
    ? 'failed'
    : turn.run_status === 'waiting_for_approval'
      ? 'needs_you'
      : turn.state === 'pending'
        ? 'planned'
        : turn.state === 'active'
          ? 'working'
          : 'done'
  const text = replyText(sqlite, turn.message_id)
  return {
    id: `turn:${turn.message_id}`,
    kind: 'step',
    title: redact(text).slice(0, 80) || (state === 'planned' ? 'Waiting to start' : 'Working'),
    agentId: turn.agent_id,
    state,
    subtitle: turn.from_agent_id
      ? `${turn.agent_id}, handed off by ${turn.from_agent_id}`
      : turn.agent_id,
    taskId: null,
    layout: { col: 0, row: 0 },
  }
}

function taskNode(sqlite: DatabaseSync, taskId: string, detail: TaskDetail | undefined): FlowNode {
  if (!detail)
    return {
      id: `task:${taskId}`,
      kind: 'step',
      title: 'Task not loaded yet',
      agentId: null,
      state: 'planned',
      subtitle: '',
      taskId,
      layout: { col: 0, row: 0 },
    }
  const state: FlowNode['state'] = taskFailed(sqlite, detail)
    ? 'failed'
    : detail.column === 'done'
      ? 'done'
      : detail.column === 'needs_you'
        ? 'needs_you'
        : detail.column === 'planned'
          ? 'planned'
          : 'working'
  return {
    id: `task:${taskId}`,
    kind: 'step',
    title: detail.title,
    agentId: detail.assignee,
    state,
    subtitle: [detail.assignee ?? 'Unassigned', detail.key].join(', '),
    taskId,
    layout: { col: 0, row: 0 },
  }
}

export interface BriefGraph {
  row: BriefRow
  summary: BriefSummary
  turns: TurnRow[]
  tasks: { taskId: string; detail: TaskDetail | undefined }[]
  nodes: FlowNode[]
  edges: FlowEdge[]
  handoffs: { id: string; kind: FlowEdge['kind']; at: string; from: string; to: string }[]
}

const edgeId = (kind: string, from: string, to: string) => `${kind}:${from}>${to}`

export function buildBriefGraph(sqlite: DatabaseSync, briefId: string): BriefGraph {
  const row = requireBrief(sqlite, briefId)
  const summary = briefSummary(sqlite, row)
  const turns = briefTurns(sqlite, briefId)
  const tasks = briefTasks(sqlite, briefId)
  const briefNodeId = `brief:${briefId}`
  const nodes: FlowNode[] = [
    {
      id: briefNodeId,
      kind: 'brief',
      title: row.title,
      agentId: null,
      state:
        summary.status === 'done' ? 'done' : summary.status === 'failed' ? 'failed' : 'working',
      subtitle: summary.status === 'paused' ? 'Paused' : '',
      taskId: null,
      layout: { col: 0, row: 0 },
    },
  ]
  const known = new Set([briefNodeId])
  const push = (node: FlowNode) => {
    if (known.has(node.id)) return
    known.add(node.id)
    nodes.push(node)
  }
  for (const turn of turns) push(turnNode(sqlite, turn))
  for (const { taskId, detail } of tasks) push(taskNode(sqlite, taskId, detail))
  const announced = z
    .array(EdgeRowSchema)
    .parse(
      sqlite
        .prepare(
          'SELECT id, kind, from_block, to_block, at FROM brief_edges WHERE brief_id = ? ORDER BY at, rowid',
        )
        .all(briefId),
    )
  for (const { taskId, detail } of tasks) {
    const id = `review:${taskId}`
    const history = announced.filter((edge) => edge.from_block === id || edge.to_block === id)
    if (!history.length) continue
    const reviewRunId = detail?.reviewer
      ? latestRunId(runsForAgent(sqlite, detail.runIds, detail.reviewer), sqlite)
      : undefined
    const run = reviewRunId ? runSummary(sqlite, reviewRunId) : null
    push({
      id,
      kind: 'step',
      title: `Review: ${detail?.title ?? 'Task'}`,
      agentId: detail?.reviewer ?? null,
      state: run
        ? run.status === 'waiting_for_approval'
          ? 'needs_you'
          : ACTIVE_RUN_STATUSES.includes(run.status)
            ? 'working'
            : FAILED_RUN.includes(run.status)
              ? 'failed'
              : 'done'
        : history.at(-1)?.kind === 'sent_back' || detail?.column === 'done'
          ? 'done'
          : 'planned',
      subtitle: detail?.reviewer ?? 'Review',
      taskId,
      layout: { col: 0, row: 0 },
    })
  }

  // Plan steps nobody started yet are shown as planned nodes.
  const planNodes: { id: string; turn: string }[] = []
  const started = new Set(
    z
      .array(z.object({ message_id: z.string() }))
      .parse(
        sqlite.prepare('SELECT message_id FROM brief_plan_starts WHERE brief_id = ?').all(briefId),
      )
      .map((start) => start.message_id),
  )
  for (const turn of turns.filter((item) => item.state === 'completed')) {
    if (started.has(turn.message_id)) continue
    const planMessage = sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(turn.message_id)
    if (!planMessage) continue
    for (const part of messageFromRow(planMessage).parts) {
      if (part.kind !== 'plan' || part.briefId !== briefId) continue
      const steps = part.lanes
        .flatMap((lane) => lane.blocks.map((block) => ({ lane, block })))
        .sort((left, right) => left.block.id.localeCompare(right.block.id, 'en', { numeric: true }))
      for (const { lane, block } of steps) {
        push({
          id: block.id,
          kind: 'step',
          title: block.label,
          agentId: lane.agentId,
          state: 'planned',
          subtitle: `${lane.agentId}, planned`,
          taskId: null,
          layout: { col: 0, row: 0 },
        })
        planNodes.push({ id: block.id, turn: `turn:${turn.message_id}` })
      }
    }
  }

  const edges: FlowEdge[] = []
  const edgeKeys = new Set<string>()
  const addEdge = (
    kind: FlowEdge['kind'],
    from: string,
    to: string,
    label: string | null = null,
    id = edgeId(kind, from, to),
  ) => {
    if (from === to || !known.has(from) || !known.has(to) || edgeKeys.has(id)) return
    edgeKeys.add(id)
    edges.push({ id, from, to, kind, label })
  }
  const handoffs: BriefGraph['handoffs'] = []

  // Turns: the first hop hangs off the brief; later hops are hand-offs from the turn that mentioned them.
  for (const turn of turns) {
    const node = `turn:${turn.message_id}`
    if (turn.hop === 0) addEdge('flow', briefNodeId, node)
    else {
      const parent = turns.find((item) => item.message_id === turn.parent_message_id)
      const from = parent ? `turn:${parent.message_id}` : `turn:${turn.parent_message_id}`
      addEdge('handoff', from, node, null, turn.turn_id)
      handoffs.push({ id: turn.turn_id, kind: 'handoff', at: turn.created_at, from, to: node })
    }
  }
  // Tasks: Kanban parent edges inside the brief, the rest hang off the brief.
  const inBrief = new Set(tasks.map((task) => task.taskId))
  for (const { taskId, detail } of tasks) {
    const parents = (detail?.dependsOn ?? []).filter((parent) => inBrief.has(parent))
    if (parents.length)
      for (const parent of parents) addEdge('flow', `task:${parent}`, `task:${taskId}`)
    else addEdge('flow', briefNodeId, `task:${taskId}`)
  }
  // Announced hand-offs, reviews and sent-back edges; endpoints are lane block ids, message ids or node ids.
  const blocks = new Map(
    z
      .array(BlockRowSchema)
      .parse(
        sqlite
          .prepare('SELECT block_id, node_id FROM brief_blocks WHERE brief_id = ?')
          .all(briefId),
      )
      .map((block) => [block.block_id, block.node_id]),
  )
  const resolve = (block: string): string | undefined =>
    [blocks.get(block), block, `turn:${block}`, `task:${block}`].find(
      (candidate) => candidate !== undefined && known.has(candidate),
    )
  for (const edge of announced) {
    const from = resolve(edge.from_block)
    const to = resolve(edge.to_block)
    if (!from || !to || from === to || edgeKeys.has(edge.id)) continue
    addEdge(
      edge.kind,
      from,
      to,
      edge.kind === 'review' ? 'Review' : edge.kind === 'sent_back' ? 'Sent back' : null,
      edge.id,
    )
    handoffs.push({ id: edge.id, kind: edge.kind, at: edge.at, from, to })
  }
  // Plan steps follow one another; the first hangs off the turn that proposed the plan.
  planNodes.forEach((step, index) => {
    addEdge('planned', index === 0 ? step.turn : planNodes[index - 1]!.id, step.id)
  })
  return { row, summary, turns, tasks, nodes, edges, handoffs }
}

// Dependency depth gives the column; sent-back edges point backwards and are ignored.
function layout(nodes: FlowNode[], edges: FlowEdge[]): void {
  const depth = new Map(nodes.map((node) => [node.id, 0]))
  const forward = edges.filter((edge) => edge.kind !== 'sent_back')
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false
    for (const edge of forward) {
      const next = (depth.get(edge.from) ?? 0) + 1
      if (next > (depth.get(edge.to) ?? 0) && next < nodes.length) {
        depth.set(edge.to, next)
        changed = true
      }
    }
    if (!changed) break
  }
  const rows = new Map<number, number>()
  for (const node of nodes) {
    const col = depth.get(node.id) ?? 0
    const row = rows.get(col) ?? 0
    rows.set(col, row + 1)
    node.layout = { col, row }
  }
}

function taskRunIds(graph: BriefGraph): string[] {
  return [
    ...graph.turns.flatMap((turn) => (turn.run_id ? [turn.run_id] : [])),
    ...graph.tasks.flatMap(({ detail }) => detail?.runIds ?? []),
  ]
}

const RunRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  cost_usd: z.number().nullable(),
})

export function readBriefFlow(
  sqlite: DatabaseSync,
  briefId: string,
  nowMs: number,
): Omit<BriefFlow, 'asOfSeq'> {
  const graph = buildBriefGraph(sqlite, briefId)
  const all = graph.nodes
  layout(all, graph.edges)
  const runs = [...new Set(taskRunIds(graph))].flatMap((id) => {
    const row = sqlite
      .prepare('SELECT id, status, started_at, ended_at, cost_usd FROM runs WHERE id = ?')
      .get(id)
    return row === undefined ? [] : [RunRowSchema.parse(row)]
  })
  const costs = runs.flatMap((run) => (run.cost_usd === null ? [] : [run.cost_usd]))
  const firstStart = graph.turns[0]?.created_at ?? graph.row.started_at
  const active =
    graph.summary.status === 'running' ||
    runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))
  const lastEnd = runs.reduce(
    (latest, run) => (run.ended_at && run.ended_at > latest ? run.ended_at : latest),
    firstStart,
  )
  const endMs = active ? nowMs : Date.parse(lastEnd)
  const stats = {
    runningSec: Math.max(0, Math.round((endMs - Date.parse(firstStart)) / 1000)),
    steps: all.length - 1,
    handoffs: graph.edges.filter((edge) => edge.kind === 'handoff').length,
    spendUsd: costs.length ? Number(costs.reduce((sum, cost) => sum + cost, 0).toFixed(6)) : null,
    eta: null,
  }
  let nodes = all
  let edges = graph.edges
  if (all.length > MAX_FLOW_NODES) {
    const more: FlowNode = {
      id: `more:${briefId}`,
      kind: 'step',
      title: `+${all.length - (MAX_FLOW_NODES - 1)} more steps`,
      agentId: null,
      state: 'planned',
      subtitle: '',
      taskId: null,
      layout: { col: 0, row: 0 },
    }
    nodes = [...all.slice(0, MAX_FLOW_NODES - 1), more]
    const kept = new Set(nodes.map((node) => node.id))
    edges = edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to))
    layout(nodes, edges)
  }
  return {
    brief: graph.summary,
    nodes,
    edges,
    stats,
    notice: unlinkedWorkNotice(sqlite, briefId, all, firstStart, endMs),
  }
}

// Links stay exact, so other work these agents did during the brief is left out; say so rather than guess.
function unlinkedWorkNotice(
  sqlite: DatabaseSync,
  briefId: string,
  nodes: readonly FlowNode[],
  fromIso: string,
  toMs: number,
): string | null {
  const agents = [...new Set(nodes.flatMap((node) => (node.agentId ? [node.agentId] : [])))]
  if (!agents.length) return null
  const other = sqlite
    .prepare(
      `SELECT 1 FROM task_projections
        WHERE json_extract(detail, '$.assignee') IN (SELECT value FROM json_each(?))
          AND json_extract(detail, '$.updatedAt') BETWEEN ? AND ?
          AND id NOT IN (SELECT task_id FROM brief_tasks WHERE brief_id = ?)
        LIMIT 1`,
    )
    .get(JSON.stringify(agents), fromIso, new Date(toMs).toISOString(), briefId)
  return other
    ? "These agents also worked on tasks this brief didn't start; they aren't shown here."
    : null
}

/** Which brief a node belongs to: turns by their chain, tasks by their newest link. */
export function briefOfNode(sqlite: DatabaseSync, nodeId: string): string {
  const [kind, ...rest] = nodeId.split(':')
  const id = rest.join(':')
  const notFound = () => new HttpError(404, 'not_found', 'Unknown flow node')
  if (!id) throw notFound()
  let row: unknown
  if (kind === 'brief')
    row = sqlite.prepare('SELECT id AS brief_id FROM briefs WHERE id = ?').get(id)
  else if (kind === 'turn')
    row = sqlite
      .prepare('SELECT chain_id AS brief_id FROM message_runs WHERE message_id = ?')
      .get(id)
  else if (kind === 'task' || kind === 'review')
    row = sqlite
      .prepare(
        'SELECT brief_id FROM brief_tasks WHERE task_id = ? ORDER BY linked_at DESC, rowid DESC LIMIT 1',
      )
      .get(id)
  else if (kind === 'plan')
    row = sqlite
      .prepare('SELECT id AS brief_id FROM briefs WHERE id = ?')
      .get(id.slice(0, id.lastIndexOf(':')))
  if (!row) throw notFound()
  return z.object({ brief_id: z.string() }).parse(row).brief_id
}

function runSummary(sqlite: DatabaseSync, runId: string): RunSummary | null {
  const row = sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(runId)
  if (row === undefined) return null
  const run = z
    .object({
      id: z.string(),
      profile: z.string(),
      origin: RunSummarySchema.shape.origin,
      status: RunSummarySchema.shape.status,
      model: z.string().nullable(),
      started_at: z.string(),
      ended_at: z.string().nullable(),
      input_tokens: z.int().nullable(),
      output_tokens: z.int().nullable(),
      cost_usd: z.number().nullable(),
      tools_used: z.string(),
    })
    .parse(row)
  const gaps = z
    .array(z.object({ from: z.string(), to: z.string().nullable(), reason: z.string() }))
    .parse(
      sqlite
        .prepare(
          'SELECT from_ts AS "from", to_ts AS "to", reason FROM gaps WHERE run_id = ? ORDER BY id',
        )
        .all(runId),
    )
  return RunSummarySchema.parse({
    id: run.id,
    agentId: run.profile,
    origin: run.origin,
    status: run.status,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    model: run.model,
    toolsUsed: z.array(z.string()).parse(JSON.parse(run.tools_used)),
    tokens:
      run.input_tokens === null || run.output_tokens === null
        ? null
        : { input: run.input_tokens, output: run.output_tokens },
    costUsd: run.cost_usd,
    refs: [],
    gaps,
  })
}

export function latestRunId(runIds: string[], sqlite: DatabaseSync): string | undefined {
  return runIds
    .flatMap((id) => {
      const row = sqlite.prepare('SELECT started_at FROM runs WHERE id = ?').get(id)
      return row === undefined
        ? []
        : [{ id, at: z.object({ started_at: z.string() }).parse(row).started_at }]
    })
    .sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0))[0]?.id
}

function runsForAgent(sqlite: DatabaseSync, runIds: string[], agentId: string | null): string[] {
  if (!agentId) return []
  return runIds.filter((id) => {
    const row = sqlite.prepare('SELECT profile FROM runs WHERE id = ?').get(id)
    return row !== undefined && z.object({ profile: z.string() }).parse(row).profile === agentId
  })
}

function pendingRunApproval(sqlite: DatabaseSync, runId: string) {
  const row = sqlite
    .prepare(
      `SELECT * FROM approvals WHERE run_id = ? AND visible = 1 AND phase = 'human_pending' AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(runId)
  return row === undefined ? null : approvalView(sqlite, ApprovalRowSchema.parse(row))
}

/** The step's agent as the Watch page knows it: a link target and the surface of its last frame. */
function watchOf(sqlite: DatabaseSync, agentId: string | null): FlowNodeDetail['watch'] {
  if (!agentId) return null
  const row = sqlite
    .prepare('SELECT surface FROM watch_frames WHERE agent_id = ? ORDER BY seq DESC LIMIT 1')
    .get(agentId)
  return row
    ? { agentId, thumbnail: null, front: z.object({ surface: z.string() }).parse(row).surface }
    : null
}

export function readFlowNode(sqlite: DatabaseSync, nodeId: string, nowMs: number): FlowNodeDetail {
  const briefId = briefOfNode(sqlite, nodeId)
  const flow = readBriefFlow(sqlite, briefId, nowMs)
  const node = flow.nodes.find((item) => item.id === nodeId)
  if (!node) throw new HttpError(404, 'not_found', 'Unknown flow node')
  const empty = { steps: [], approval: null, run: null, model: null, tools: [], watch: null }
  if (nodeId.startsWith('turn:')) {
    const turn = briefTurns(sqlite, briefId).find((item) => `turn:${item.message_id}` === nodeId)
    const run = turn?.run_id ? runSummary(sqlite, turn.run_id) : null
    return FlowNodeDetailSchema.parse({
      node,
      ...empty,
      description: turn ? replyBody(sqlite, turn.message_id) : '',
      approval: turn?.run_id ? pendingRunApproval(sqlite, turn.run_id) : null,
      run,
      model: run?.model ?? null,
      tools: run?.toolsUsed ?? [],
      watch: watchOf(sqlite, node.agentId),
    })
  }
  if (node.taskId) {
    const task = briefTasks(sqlite, briefId).find((item) => item.taskId === node.taskId)
    const detail = task?.detail ? taskWithApproval(sqlite, task.detail, nowMs) : undefined
    const runId = detail
      ? latestRunId(runsForAgent(sqlite, detail.runIds, node.agentId), sqlite)
      : undefined
    const run = runId ? runSummary(sqlite, runId) : null
    return FlowNodeDetailSchema.parse({
      node,
      ...empty,
      description: detail?.body ?? '',
      steps: detail?.steps ?? [],
      approval:
        detail?.pendingApproval?.agentId === node.agentId
          ? detail.pendingApproval
          : runId
            ? pendingRunApproval(sqlite, runId)
            : null,
      run,
      model: run?.model ?? null,
      tools: run?.toolsUsed ?? [],
      watch: watchOf(sqlite, node.agentId),
    })
  }
  return FlowNodeDetailSchema.parse({ node, ...empty, description: node.title })
}

function replyBody(sqlite: DatabaseSync, messageId: string): string {
  const row = sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(messageId)
  if (!row) return ''
  return redact(
    messageFromRow(row)
      .parts.filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('\n'),
  ).slice(0, 4000)
}

export interface StoppableRun {
  agentId: string
  runId: string
}

/** The active run behind a step, or a 409 when nothing is running. */
export function activeRunOfNode(sqlite: DatabaseSync, nodeId: string): StoppableRun {
  const briefId = briefOfNode(sqlite, nodeId)
  if (nodeId.startsWith('brief:') || nodeId.startsWith('plan:'))
    throw new HttpError(400, 'bad_request', 'Stop a step, not the whole brief')
  const candidates: string[] = nodeId.startsWith('turn:')
    ? briefTurns(sqlite, briefId)
        .filter((turn) => `turn:${turn.message_id}` === nodeId && turn.run_id)
        .map((turn) => turn.run_id!)
    : (() => {
        const node = buildBriefGraph(sqlite, briefId).nodes.find((item) => item.id === nodeId)
        const detail = briefTasks(sqlite, briefId).find(
          (task) => task.taskId === node?.taskId,
        )?.detail
        return detail ? runsForAgent(sqlite, detail.runIds, node?.agentId ?? null) : []
      })()
  for (const runId of [...candidates].reverse()) {
    const row = sqlite.prepare('SELECT profile, status, origin FROM runs WHERE id = ?').get(runId)
    if (row === undefined) continue
    const run = z.object({ profile: z.string(), status: z.string(), origin: z.string() }).parse(row)
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) continue
    return { agentId: run.profile, runId }
  }
  throw new HttpError(409, 'conflict', 'Nothing is running in this step')
}

const LOG_PAGE = 100
const MAX_LOG_LINES = 2000

export function readBriefLog(
  sqlite: DatabaseSync,
  briefId: string,
  query: {
    agent?: string | undefined
    kind?: 'tool' | 'all' | undefined
    cursor?: string | undefined
  },
): BriefLogPage {
  const graph = buildBriefGraph(sqlite, briefId)
  const lines: LogLine[] = [
    {
      id: `brief:${briefId}`,
      at: graph.row.started_at,
      agentId: graph.row.started_by,
      kind: 'system',
      text: `Brief started: ${graph.row.title}`,
    },
  ]
  if (graph.row.paused_at)
    lines.push({
      id: `paused:${briefId}`,
      at: graph.row.paused_at,
      agentId: graph.row.started_by,
      kind: 'system',
      text: 'Paused: current steps finish, nothing new starts',
    })
  const agentOf = new Map(graph.nodes.map((node) => [node.id, node.agentId]))
  for (const turn of graph.turns) {
    const text = replyText(sqlite, turn.message_id)
    if (text)
      lines.push({
        id: `message:${turn.message_id}`,
        at: turn.created_at,
        agentId: turn.agent_id,
        kind: 'message',
        text: redact(text).slice(0, 200),
      })
  }
  for (const handoff of graph.handoffs) {
    const from = agentOf.get(handoff.from) ?? 'someone'
    const to = agentOf.get(handoff.to) ?? 'someone'
    lines.push({
      id: `handoff:${handoff.id}`,
      at: handoff.at,
      agentId: from,
      kind: 'handoff',
      text:
        handoff.kind === 'review'
          ? `${from} asked ${to} to review`
          : handoff.kind === 'sent_back'
            ? `${from} sent the work back to ${to}`
            : `${from} handed off to ${to}`,
    })
  }
  const runIds = [...new Set(taskRunIds(graph))]
  for (const runId of runIds) {
    const profile = z
      .object({ profile: z.string() })
      .optional()
      .parse(sqlite.prepare('SELECT profile FROM runs WHERE id = ?').get(runId))?.profile
    if (!profile) continue
    for (const tool of z
      .array(
        z.object({ seq: z.int(), tool: z.string(), started_at: z.string(), status: z.string() }),
      )
      .parse(
        sqlite
          .prepare(
            'SELECT seq, tool, started_at, status FROM tool_calls WHERE run_id = ? ORDER BY seq',
          )
          .all(runId),
      ))
      lines.push({
        id: `tool:${runId}:${tool.seq}`,
        at: tool.started_at,
        agentId: profile,
        kind: 'tool',
        text: tool.status === 'error' ? `${tool.tool} failed` : `Used ${tool.tool}`,
      })
    const approval = pendingRunApproval(sqlite, runId)
    if (approval)
      lines.push({
        id: `approval:${approval.id}`,
        at: approval.createdAt,
        agentId: approval.agentId,
        kind: 'approval',
        text: `Asked: ${approval.title}`,
      })
  }
  for (const { detail } of graph.tasks) {
    const approval = detail ? taskWithApproval(sqlite, detail).pendingApproval : null
    if (approval && !lines.some((line) => line.id === `approval:${approval.id}`))
      lines.push({
        id: `approval:${approval.id}`,
        at: approval.createdAt,
        agentId: approval.agentId,
        kind: 'approval',
        text: `Asked: ${approval.title}`,
      })
  }
  lines.sort((left, right) =>
    left.at === right.at ? (left.id < right.id ? -1 : 1) : left.at < right.at ? -1 : 1,
  )
  const filtered = lines
    .filter((line) => (query.agent ? line.agentId === query.agent : true))
    .filter((line) => (query.kind === 'tool' ? line.kind === 'tool' : true))
    .slice(-MAX_LOG_LINES)
  let start = 0
  if (query.cursor) {
    const [at, ...rest] = decodeLogCursor(query.cursor)
    const id = rest.join('|')
    start = filtered.findIndex((line) => line.at > at! || (line.at === at && line.id > id))
    if (start < 0) start = filtered.length
  }
  const items = filtered.slice(start, start + LOG_PAGE)
  const last = items.at(-1)
  return BriefLogPageSchema.parse({
    items,
    nextCursor:
      last && start + LOG_PAGE < filtered.length ? encodeLogCursor(last.at, last.id) : null,
  })
}

const encodeLogCursor = (at: string, id: string) =>
  Buffer.from(`${at}|${id}`, 'utf8').toString('base64url')
function decodeLogCursor(cursor: string): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new HttpError(400, 'bad_request', 'Invalid cursor')
  const text = Buffer.from(cursor, 'base64url').toString('utf8')
  const parts = text.split('|')
  if (parts.length < 2 || !z.iso.datetime().safeParse(parts[0]).success)
    throw new HttpError(400, 'bad_request', 'Invalid cursor')
  return parts
}
