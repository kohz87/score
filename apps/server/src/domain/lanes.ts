import type { Handoff, LaneBlock, TaskColumn } from '@score/contract'

// Pure builder behind Now › Score: rows in, lane blocks and hand-offs out. No I/O, no clock.
export interface LaneRunInput {
  id: string
  agentId: string
  status: string
  startedAt: string
  endedAt: string | null
  taskId: string | null
}
export interface LaneTaskInput {
  id: string
  title: string
  assignee: string | null
  reviewer: string | null
  column: TaskColumn
}
// One message_runs hop: `agentId` was asked by `fromAgentId` (null = the human).
export interface LaneHopInput {
  id: string
  runId: string | null
  fromAgentId: string | null
  // The run that wrote the message this hop answers: the exact source. Undefined = unknown (older callers).
  parentRunId?: string | null
  agentId: string
  at: string
}
export interface LaneInput {
  agentIds: readonly string[]
  runs: readonly LaneRunInput[]
  tasks: readonly LaneTaskInput[]
  hops: readonly LaneHopInput[]
  // Runs that currently wait for a pending approval, on top of their own status.
  waitingRunIds: readonly string[]
  from: string
  to: string
  now: string
}
export interface LaneOutput {
  lanes: { agentId: string; blocks: LaneBlock[] }[]
  handoffs: Handoff[]
}

interface Draft {
  id: string
  label: string
  state: LaneBlock['state']
  start: number
  end: number | null
  taskId: string | null
  runId: string | null
  agentId: string
  runIds: string[]
}

const FINISHED = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const iso = (ms: number) => new Date(ms).toISOString()

function runDrafts(input: LaneInput, tasks: Map<string, LaneTaskInput>): Draft[] {
  const waiting = new Set(input.waitingRunIds)
  const runs = [...input.runs].sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id),
  )
  const drafts: Draft[] = []
  const lastForTask = new Map<string, Draft>()
  for (const run of runs) {
    const start = Date.parse(run.startedAt)
    const finished = FINISHED.has(run.status) && !waiting.has(run.id)
    const state: LaneBlock['state'] =
      waiting.has(run.id) || run.status === 'waiting_for_approval'
        ? 'waiting'
        : finished
          ? 'done'
          : 'working'
    const ended = run.endedAt === null ? null : Date.parse(run.endedAt)
    const end = state === 'done' ? (ended ?? start) : null
    const task = run.taskId === null ? undefined : tasks.get(run.taskId)
    const reviewing =
      task !== undefined && task.reviewer === run.agentId && task.assignee !== run.agentId
    const label =
      state === 'waiting'
        ? 'Waiting on you'
        : task === undefined
          ? 'Working'
          : reviewing
            ? `Review: ${task.title}`
            : task.title
    const previous = run.taskId === null ? undefined : lastForTask.get(run.taskId)
    // Consecutive runs for one task merge, unless another agent worked on it in between or someone waits.
    if (
      previous &&
      previous.agentId === run.agentId &&
      previous.state !== 'waiting' &&
      state !== 'waiting'
    ) {
      previous.state = state
      previous.end = end
      previous.runId = run.id
      previous.runIds.push(run.id)
      continue
    }
    const draft: Draft = {
      id: `run:${run.id}`,
      label,
      state,
      start,
      end,
      taskId: run.taskId,
      runId: run.id,
      agentId: run.agentId,
      runIds: [run.id],
    }
    drafts.push(draft)
    if (run.taskId !== null) lastForTask.set(run.taskId, draft)
  }
  return drafts
}

function plannedDrafts(input: LaneInput, drafts: Draft[]): Draft[] {
  const now = Date.parse(input.now)
  const planned: Draft[] = []
  for (const task of input.tasks) {
    if (task.column === 'planned' && task.assignee) {
      planned.push({
        id: `task:${task.id}`,
        label: task.title,
        state: 'planned',
        start: now,
        end: null,
        taskId: task.id,
        runId: null,
        agentId: task.assignee,
        runIds: [],
      })
    } else if (task.column === 'in_review' && task.reviewer) {
      const reviewer = task.reviewer
      // Planned only while the reviewer has not picked the task up: its latest block is not theirs.
      const latest = drafts.filter((draft) => draft.taskId === task.id).at(-1)
      const active = latest?.agentId === reviewer
      if (!active)
        planned.push({
          id: `task:${task.id}:review`,
          label: `Review: ${task.title}`,
          state: 'planned',
          start: now,
          end: null,
          taskId: task.id,
          runId: null,
          agentId: reviewer,
          runIds: [],
        })
    }
  }
  return planned
}

export function taskHandoffKind(
  fromAgentId: string,
  toAgentId: string,
  task: Pick<LaneTaskInput, 'assignee' | 'reviewer'> | undefined,
): Handoff['kind'] {
  if (task?.assignee && task.reviewer) {
    if (fromAgentId === task.assignee && toAgentId === task.reviewer) return 'review'
    if (fromAgentId === task.reviewer && toAgentId === task.assignee) return 'sent_back'
  }
  return 'handoff'
}

function buildHandoffs(
  input: LaneInput,
  drafts: Draft[],
  tasks: Map<string, LaneTaskInput>,
): { handoff: Handoff; from: string; to: string }[] {
  const found = new Map<string, { handoff: Handoff; from: string; to: string }>()
  const add = (from: Draft, to: Draft, at: number) => {
    if (from.id === to.id || from.agentId === to.agentId) return
    const key = `${from.id}>${to.id}`
    if (found.has(key)) return
    found.set(key, {
      from: from.id,
      to: to.id,
      handoff: {
        id: `handoff:${key}`,
        from: { agentId: from.agentId, blockId: from.id },
        to: { agentId: to.agentId, blockId: to.id },
        kind: taskHandoffKind(
          from.agentId,
          to.agentId,
          tasks.get(to.taskId ?? '') ?? tasks.get(from.taskId ?? ''),
        ),
        at: iso(at),
      },
    })
  }
  const byTask = new Map<string, Draft[]>()
  for (const draft of drafts)
    if (draft.taskId !== null)
      byTask.set(draft.taskId, [...(byTask.get(draft.taskId) ?? []), draft])
  for (const sequence of byTask.values())
    for (let index = 1; index < sequence.length; index += 1)
      add(sequence[index - 1]!, sequence[index]!, sequence[index]!.start)
  for (const hop of input.hops) {
    if (hop.runId === null || hop.fromAgentId === null) continue
    const to = drafts.find((draft) => draft.runIds.includes(hop.runId!))
    if (!to) continue
    const from =
      hop.parentRunId === undefined
        ? drafts
            .filter((draft) => draft.agentId === hop.fromAgentId && draft.start <= to.start)
            .sort((a, b) => b.start - a.start)[0]
        : drafts.find((draft) => draft.runIds.includes(hop.parentRunId ?? ''))
    if (from) add(from, to, Date.parse(hop.at))
  }
  return [...found.values()]
}

export function buildLanes(input: LaneInput): LaneOutput {
  const from = Date.parse(input.from)
  const to = Date.parse(input.to)
  const agents = new Set(input.agentIds)
  const tasks = new Map(input.tasks.map((task) => [task.id, task]))
  const drafts = runDrafts(input, tasks).filter((draft) => agents.has(draft.agentId))
  const all = [...drafts, ...plannedDrafts(input, drafts).filter((d) => agents.has(d.agentId))]
  const visible = new Map<string, LaneBlock>()
  for (const draft of all) {
    if (draft.start > to || (draft.end !== null && draft.end < from)) continue
    visible.set(draft.id, {
      id: draft.id,
      label: draft.label,
      state: draft.state,
      start: iso(Math.max(draft.start, from)),
      end: draft.end === null ? null : iso(Math.min(draft.end, to)),
      taskId: draft.taskId,
      runId: draft.runId,
    })
  }
  const byStart = (a: LaneBlock, b: LaneBlock) =>
    Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id)
  const lanes = input.agentIds.map((agentId) => ({
    agentId,
    blocks: all
      .filter((draft) => draft.agentId === agentId && visible.has(draft.id))
      .map((draft) => visible.get(draft.id)!)
      .sort(byStart),
  }))
  const handoffs = buildHandoffs(input, drafts, tasks)
    .filter((entry) => visible.has(entry.from) && visible.has(entry.to))
    .map((entry) => entry.handoff)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
  return { lanes, handoffs }
}
