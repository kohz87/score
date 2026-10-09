import type { Handoff, LaneBlock, TaskColumn } from '@score/contract'

// Pure builder behind Now › Score: rows in, lane blocks and hand-offs out. No I/O, no clock.
export interface LaneRunInput {
  id: string
  agentId: string
  status: string
  startedAt: string
  endedAt: string | null
  taskId: string | null
  // What the run is: a plain chat reply merges into a band; default task (an exact block).
  kind?: LaneBlock['kind']
}
/** A Kanban attempt (5.17a-1): one finite block; an unknown claiming profile puts it in the Unattributed lane. */
export interface LaneAttemptInput {
  id: string
  agentId: string | null
  role: 'implementer' | 'reviewer' | null
  startedAt: string
  endedAt: string | null
  /** Observation stopped here without the attempt ending: the block ends here and nothing after counts. */
  observationEndedAt: string | null
  evidence: 'proven' | 'partial'
  /** Upstream attempt id, the tie-breaker of `order`. */
  attemptNumber: number
  /** Observed stretches; a block is drawn per stretch so an unobserved gap is never drawn as work. */
  observed?: readonly { startedAt: string; endedAt: string | null }[]
  /** Null for an attempt from an earlier copy of the board: its task must not be linked. */
  taskId: string | null
  /** The task of the attempt (whatever the lineage), for the block label. */
  taskTitle: string | null
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
  /** Present only when Kanban attempts are enabled; absent leaves the output exactly as before. */
  attempts?: readonly LaneAttemptInput[]
  hops: readonly LaneHopInput[]
  // Runs that currently wait for a pending approval, on top of their own status.
  waitingRunIds: readonly string[]
  from: string
  to: string
  now: string
}
export interface LaneOutput {
  lanes: { agentId: string; blocks: LaneBlock[] }[]
  /** Blocks of attempts whose agent is unknown; present only when `attempts` was given. */
  unattributed?: LaneBlock[]
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
  agentId: string | null
  runIds: string[]
  kind: LaneBlock['kind']
  count?: number
  attempt?: Pick<LaneBlock, 'attemptId' | 'provenance' | 'observationEndedAt' | 'order'>
}

// Chat replies of one agent closer together than this are one band.
export const CHAT_MERGE_GAP_MS = 5 * 60 * 1000

const FINISHED = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const iso = (ms: number) => new Date(ms).toISOString()

function attemptDrafts(attempt: LaneAttemptInput): Draft[] {
  const attemptStart = Date.parse(attempt.startedAt)
  const attemptEnd = attempt.endedAt === null ? null : Date.parse(attempt.endedAt)
  const label =
    attempt.taskTitle === null
      ? 'Working'
      : attempt.role === 'reviewer'
        ? `Review: ${attempt.taskTitle}`
        : attempt.taskTitle
  // One block per observed stretch: a finished attempt ends at its end, one that stopped being observed ends at the
  // boundary (never later), and one observed again continues in a new block after the unobserved gap.
  const stretches = attempt.observed?.length
    ? attempt.observed.map((interval) => ({
        start: Math.max(attemptStart, Date.parse(interval.startedAt)),
        end: interval.endedAt === null ? attemptEnd : Date.parse(interval.endedAt),
        boundary:
          interval.endedAt !== null &&
          (attemptEnd === null || Date.parse(interval.endedAt) < attemptEnd)
            ? interval.endedAt
            : null,
      }))
    : [
        {
          start: attemptStart,
          end:
            attemptEnd !== null
              ? attemptEnd
              : attempt.observationEndedAt !== null
                ? Date.parse(attempt.observationEndedAt)
                : null,
          boundary: attempt.observationEndedAt,
        },
      ]
  return stretches.map((stretch, index) => ({
    id: index === 0 ? `attempt:${attempt.id}` : `attempt:${attempt.id}:${index}`,
    label,
    state: stretch.end === null ? 'working' : 'done',
    start: stretch.start,
    end: stretch.end === null ? null : Math.max(stretch.start, stretch.end),
    taskId: attempt.taskId,
    runId: null,
    agentId: attempt.agentId,
    runIds: [],
    kind: 'task',
    attempt: {
      attemptId: attempt.id,
      provenance: attempt.evidence,
      observationEndedAt: stretch.boundary,
      order: [attempt.startedAt, attempt.attemptNumber],
    },
  }))
}

function runDrafts(input: LaneInput, tasks: Map<string, LaneTaskInput>): Draft[] {
  const waiting = new Set(input.waitingRunIds)
  const runs = [...input.runs].sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id),
  )
  const drafts: Draft[] = []
  for (const run of runs) {
    const start = Date.parse(run.startedAt)
    // An ended run stays finite: a late approval is shown as separate evidence, never by reopening the block.
    const finished = FINISHED.has(run.status) || run.endedAt !== null
    const state: LaneBlock['state'] = finished
      ? 'done'
      : waiting.has(run.id) || run.status === 'waiting_for_approval'
        ? 'waiting'
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
      kind: run.taskId === null ? (run.kind ?? 'task') : 'task',
    }
    drafts.push(draft)
  }
  const merged = mergeChat(drafts)
  if (!input.attempts?.length) return merged
  // Attempts interleave with runs by start time; same-second ties keep runs first, then upstream attempt order.
  return [
    ...merged.map((draft, index) => ({ draft, rank: 0, tie: index })),
    ...input.attempts.flatMap((attempt) =>
      attemptDrafts(attempt).map((draft) => ({ draft, rank: 1, tie: attempt.attemptNumber })),
    ),
  ]
    .sort((a, b) => a.draft.start - b.draft.start || a.rank - b.rank || a.tie - b.tie)
    .map(({ draft }) => draft)
}

/**
 * Plain chat replies stay out of the task rows: one band per stretch of an agent's chatting. Only chat drafts merge;
 * task and brief blocks stay exact (an ended run stays finite, retries stay distinct).
 */
function mergeChat(drafts: Draft[]): Draft[] {
  const result: Draft[] = []
  const open = new Map<string, Draft>()
  for (const draft of drafts) {
    if (draft.kind !== 'chat') {
      result.push(draft)
      continue
    }
    // Only runs merge into bands, and a run always has an agent.
    const agentKey = draft.agentId ?? ''
    const band = open.get(agentKey)
    const bandEnd = band === undefined ? 0 : band.end === null ? Infinity : band.end
    if (band !== undefined && draft.start - bandEnd < CHAT_MERGE_GAP_MS) {
      band.runIds.push(...draft.runIds)
      band.count = (band.count ?? 1) + 1
      band.end = band.end === null || draft.end === null ? null : Math.max(band.end, draft.end)
      band.state = bandState(band, draft)
      continue
    }
    const fresh: Draft = { ...draft, id: `chat:${draft.runIds[0]}`, count: 1 }
    open.set(agentKey, fresh)
    result.push(fresh)
  }
  for (const band of result)
    if (band.kind === 'chat') band.label = chatLabel(band.count ?? 1, band.state)
  return result
}
function bandState(band: Draft, next: Draft): LaneBlock['state'] {
  if (band.state === 'waiting' || next.state === 'waiting') return 'waiting'
  return band.end === null || next.end === null ? 'working' : 'done'
}
function chatLabel(count: number, state: LaneBlock['state']): string {
  if (state === 'waiting') return 'Waiting on you'
  return count === 1 ? 'Chat reply' : `Chat · ${count} replies`
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
        kind: 'task',
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
          kind: 'task',
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
        kind:
          from.agentId === null || to.agentId === null
            ? 'handoff'
            : taskHandoffKind(
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
  // An attempt of an unknown agent belongs to the Unattributed lane; a run or attempt of an agent Score does not
  // list is not drawn (as before).
  const drafts = runDrafts(input, tasks).filter((draft) =>
    draft.agentId === null ? draft.attempt !== undefined : agents.has(draft.agentId),
  )
  const all = [
    ...drafts,
    ...plannedDrafts(input, drafts).filter((d) => d.agentId !== null && agents.has(d.agentId)),
  ]
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
      runId: draft.kind === 'chat' && (draft.count ?? 1) > 1 ? null : draft.runId,
      kind: draft.kind,
      ...(draft.count === undefined ? {} : { count: draft.count }),
      ...(draft.attempt ?? {}),
    })
  }
  // Attempt blocks tie-break by `order` (start, upstream attempt id); everything else by id as before.
  const byStart = (a: LaneBlock, b: LaneBlock) =>
    Date.parse(a.start) - Date.parse(b.start) ||
    (a.order && b.order ? a.order[1] - b.order[1] : a.id.localeCompare(b.id))
  const blocksOf = (belongs: (draft: Draft) => boolean) =>
    all
      .filter((draft) => belongs(draft) && visible.has(draft.id))
      .map((draft) => visible.get(draft.id)!)
      .sort(byStart)
  const lanes = input.agentIds.map((agentId) => ({
    agentId,
    blocks: blocksOf((draft) => draft.agentId === agentId),
  }))
  const handoffs = buildHandoffs(input, drafts, tasks)
    .filter((entry) => visible.has(entry.from) && visible.has(entry.to))
    .map((entry) => entry.handoff)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
  return {
    lanes,
    handoffs,
    ...(input.attempts ? { unattributed: blocksOf((draft) => draft.agentId === null) } : {}),
  }
}
