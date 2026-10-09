import type { Reports, ReportRange } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { kanbanAttemptsEnabled, listAttempts } from './kanban-attempts.ts'

/** One kanban task as Hermes recorded it (times in epoch ms). */
export interface KanbanTaskFact {
  id: string
  assignee: string | null
  status: string
  createdAt: number
  completedAt: number | null
  hasParents: boolean
  /**
   * review_requested, changes_requested, completed, promoted, blocked, unblocked. `id` is Hermes' event id: order
   * is by id, never by `at` alone (several events share a second). `actor` is the profile that owned the wait the
   * event opens (the implementer on review_requested), null when Hermes did not record one.
   */
  events: { id: number; kind: string; at: number; actor: string | null }[]
}

/** What Hermes knows that Score's own tables do not (read-only, through the adapter). */
export interface ReportFacts {
  tasks: KanbanTaskFact[]
  /** Spend per agent in the window; null when that agent's cost data is unavailable. */
  spendUsd: Record<string, number | null>
  /** Prompt-token counts per agent in the window; null/absent = Hermes gives no cache tokens (shown as "—"). */
  cache?: Record<string, CacheTokens | null>
}

/** `read` = tokens served from the prompt cache; `total` = read + written + uncached input. */
export interface CacheTokens {
  read: number
  total: number
}

/** Cache hit rate: read / total, null when unknown or nothing was sent. */
export function cacheHitRate(tokens: CacheTokens | null | undefined): number | null {
  return tokens && tokens.total > 0 ? Math.min(1, tokens.read / tokens.total) : null
}

export interface ReportRun {
  agentId: string
  startedAt: string
  endedAt: string | null
  /** False for a Kanban attempt whose claim could not be proven: counted as a run, never as working time. */
  work?: boolean
  /** Observed stretches of a Kanban attempt: the gaps between them are not working time. */
  observed?: { startedAt: string; endedAt: string | null }[]
}
/** A Kanban attempt for reports (5.17a-1). `endedAt` is where it ended or where observation stopped; null = running. */
export interface ReportAttempt {
  agentId: string | null
  startedAt: string
  endedAt: string | null
  evidence: 'proven' | 'partial'
  observed?: { startedAt: string; endedAt: string | null }[]
}
/** [start, end] of a run, or of each observed stretch of an attempt (an open one runs to now). */
function stretchesOf(
  run: Pick<ReportRun, 'startedAt' | 'endedAt' | 'observed'>,
  now: number,
): Interval[] {
  if (run.observed?.length)
    return run.observed.map((stretch): Interval => [
      Math.max(Date.parse(run.startedAt), Date.parse(stretch.startedAt)),
      stretch.endedAt ? Date.parse(stretch.endedAt) : run.endedAt ? Date.parse(run.endedAt) : now,
    ])
  return [[Date.parse(run.startedAt), run.endedAt ? Date.parse(run.endedAt) : now]]
}
export interface ReportApproval {
  agentId: string
  stage: 'guardian' | 'human'
  visible: boolean
  status: string
  decisionBy: string | null
  createdAt: string
  decidedAt: string | null
  closedAt: string | null
}

export interface ReportWindow {
  from: number
  to: number
  /** Local calendar days (YYYY-MM-DD) covered, oldest first. */
  days: string[]
}

/** Inclusive local days (YYYY-MM-DD) of a custom range. */
export interface CustomDays {
  from: string
  to: string
}

export interface ReportInput {
  range: ReportRange
  custom?: CustomDays
  now: number
  tz?: string
  agentIds: string[]
  runs: ReportRun[]
  /** Present only with Kanban attempts enabled; absent leaves the report exactly as before. */
  attempts?: ReportAttempt[]
  approvals: ReportApproval[]
  facts: ReportFacts
}

const DAYS = { today: 1, '7d': 7, '30d': 30 } as const

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

// An Intl formatter costs far more than the calls it serves: build one per zone.
const dayFormatters = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let found = dayFormatters.get(tz)
  if (!found) {
    found = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    if (dayFormatters.size > 64) dayFormatters.clear()
    dayFormatters.set(tz, found)
  }
  return found
}

function dayKey(ms: number, tz: string): string {
  return formatter(tz).format(ms)
}

/** The first instant of local day `key`: the smallest time whose local date is `key` or later. Handles a midnight that
 * does not exist (clocks jump over it) or happens twice. Local dates only grow with time, so a bisection finds it. */
export function startOfDay(key: string, tz: string): number {
  const guess = Date.parse(`${key}T00:00:00Z`)
  // No zone is more than 14 hours from UTC, so the boundary lies within a day either side of the UTC midnight.
  let low = guess - 86_400_000 // local date < key here
  let high = guess + 86_400_000 // local date >= key here
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2)
    if (dayKey(mid, tz) >= key) high = mid
    else low = mid
  }
  return high
}

export function addDays(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

export const MAX_CUSTOM_DAYS = 366

/** The local day `now` falls on in `tz`. */
export function todayKey(now: number, tz = localTimeZone()): string {
  return dayKey(now, tz)
}

/** A reason a custom range is unusable, or null. Days are compared as calendar keys, so a DST change is no issue. */
export function customRangeProblem(
  custom: CustomDays,
  now: number,
  tz = localTimeZone(),
): string | null {
  const valid = (key: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(key) &&
    Number.isFinite(Date.parse(`${key}T00:00:00Z`)) &&
    addDays(key, 0) === key
  if (!valid(custom.from) || !valid(custom.to)) return 'from and to must be real dates (YYYY-MM-DD)'
  if (custom.from > custom.to) return 'from must not be after to'
  if (custom.to > dayKey(now, tz)) return 'to must not be after today'
  const span = (Date.parse(custom.to) - Date.parse(custom.from)) / 86_400_000 + 1
  if (span > MAX_CUSTOM_DAYS) return `a custom range covers at most ${MAX_CUSTOM_DAYS} days`
  return null
}

export function reportWindow(
  range: ReportRange,
  now: number,
  tz = localTimeZone(),
  custom?: CustomDays,
): ReportWindow {
  if (range === 'custom') {
    if (!custom) throw new Error('A custom range needs from and to')
    const count = (Date.parse(custom.to) - Date.parse(custom.from)) / 86_400_000 + 1
    const days = Array.from({ length: count }, (_, i) => addDays(custom.from, i))
    // The end of the last day, or now when that day is today.
    return {
      from: startOfDay(custom.from, tz),
      to: Math.min(now, startOfDay(addDays(custom.to, 1), tz) - 1),
      days,
    }
  }
  const today = dayKey(now, tz)
  const days = Array.from({ length: DAYS[range] }, (_, i) => addDays(today, i - DAYS[range] + 1))
  return { from: startOfDay(days[0]!, tz), to: now, days }
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

type Interval = [number, number]

/** Merged, window-clipped intervals. */
function merge(intervals: Interval[], from: number, to: number): Interval[] {
  const out: Interval[] = []
  for (const [s, e] of intervals
    .map(([s, e]): Interval => [Math.max(s, from), Math.min(e, to)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1)
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}
/** Parts of `intervals` not covered by `cut` (both merged and sorted). */
function subtract(intervals: Interval[], cut: Interval[]): Interval[] {
  const out: Interval[] = []
  for (const [s, e] of intervals) {
    let start = s
    for (const [cs, ce] of cut) {
      if (ce <= start || cs >= e) continue
      if (cs > start) out.push([start, cs])
      start = Math.max(start, ce)
      if (start >= e) break
    }
    if (start < e) out.push([start, e])
  }
  return out
}
const measure = (intervals: Interval[]): number =>
  intervals.reduce((total, [s, e]) => total + (e - s), 0)

/** Intervals of waiting on another agent for one task: waiting for parents, and out for review. */
function agentWaits(task: KanbanTaskFact, agentId: string, now: number): Interval[] {
  const waits: Interval[] = []
  const events = [...task.events].sort((a, b) => a.id - b.id)
  const at = (kind: string) => events.find((event) => event.kind === kind)?.at
  if (task.hasParents && task.assignee === agentId)
    waits.push([task.createdAt, at('promoted') ?? (task.status === 'todo' ? now : task.createdAt)])
  // The implementer waits for the review, whoever the task is assigned to now (Hermes hands it to the reviewer).
  for (const request of events.filter(
    (event) => event.kind === 'review_requested' && event.actor === agentId,
  )) {
    const end = events.find(
      (event) =>
        event.id > request.id && (event.kind === 'completed' || event.kind === 'changes_requested'),
    )
    waits.push([request.at, end?.at ?? (task.status === 'review' ? now : request.at)])
  }
  return waits
}

/** Intervals a task sat blocked on you. */
function blockedWaits(task: KanbanTaskFact, now: number): Interval[] {
  return task.events
    .filter((event) => event.kind === 'blocked')
    .map((block): Interval => {
      const end = task.events.find((event) => event.kind === 'unblocked' && event.id > block.id)
      return [block.at, end?.at ?? (task.status === 'blocked' ? now : block.at)]
    })
}

/** Integer percentages that add to 100 (largest remainder) so the three bars always fill the track. */
function percentages(parts: number[]): number[] {
  const total = parts.reduce((sum, part) => sum + part, 0)
  if (total <= 0) return parts.map(() => 0)
  const exact = parts.map((part) => (part / total) * 100)
  const floors = exact.map(Math.floor)
  let left = 100 - floors.reduce((sum, part) => sum + part, 0)
  const order = exact
    .map((value, i) => [value - floors[i]!, i] as const)
    .sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    floors[i]!++
    left--
  }
  return floors
}

const rate = (passed: number, reviewed: number): number | null =>
  reviewed ? passed / reviewed : null
const sum = (values: (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null)
  return known.length ? known.reduce((total, value) => total + value, 0) : null
}
// Spend is dollars; round to the cent-fraction Hermes records so float noise never reaches the UI.
const money = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 1e6) / 1e6

const RANGE_WORDS = {
  today: 'today',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
} as const

function duration(sec: number): string {
  if (sec < 90) return `${Math.round(sec)} seconds`
  if (sec < 5400) return `${Math.round(sec / 60)} minutes`
  return `${Math.round(sec / 360) / 10} hours`
}

export function computeReports(input: ReportInput): Reports {
  const tz = input.tz ?? localTimeZone()
  const { from, to, days } = reportWindow(input.range, input.now, tz, input.custom)
  // Finish time and duration are kanban's own: completed_at, and created_at to completed_at.
  const finished = input.facts.tasks.filter(
    (task) =>
      // Archiving keeps completed_at; the work was still finished in that window.
      (task.status === 'done' || task.status === 'archived') &&
      task.completedAt !== null &&
      task.completedAt >= from &&
      task.completedAt <= to,
  )
  const at = (task: KanbanTaskFact) => task.completedAt!
  const seconds = (task: KanbanTaskFact) => (at(task) - task.createdAt) / 1000
  // First pass: a review was requested and the reviewer never sent it back.
  const reviewed = (task: KanbanTaskFact) =>
    task.events.some((event) => event.kind === 'review_requested')
  const passedFirst = (task: KanbanTaskFact) =>
    !task.events.some((event) => event.kind === 'changes_requested')

  const agents = new Set(input.agentIds)
  for (const task of finished) if (task.assignee) agents.add(task.assignee)
  // Attempts of a known agent count as that agent's runs; their working time is the proven ones (5.17a-1).
  const known = (input.attempts ?? []).flatMap((attempt): ReportRun[] =>
    attempt.agentId === null
      ? []
      : [
          {
            agentId: attempt.agentId,
            startedAt: attempt.startedAt,
            endedAt: attempt.endedAt,
            work: attempt.evidence === 'proven',
            ...(attempt.observed ? { observed: attempt.observed } : {}),
          },
        ],
  )
  const allRuns = [...input.runs, ...known]
  const runs = allRuns.filter((run) => {
    const startedAt = Date.parse(run.startedAt)
    return startedAt >= from && startedAt <= to
  })
  for (const run of runs) agents.add(run.agentId)
  const agentIds = [...agents].sort()

  const taskAgents = [
    ...new Set(finished.flatMap((task) => (task.assignee ? [task.assignee] : []))),
  ].sort()
  // One formatted date per task, counted once per (agent, day).
  const perDay = new Map<string, number>()
  for (const task of finished) {
    if (!task.assignee) continue
    const key = `${task.assignee}\0${dayKey(at(task), tz)}`
    perDay.set(key, (perDay.get(key) ?? 0) + 1)
  }
  const byDay = days.map((date) => ({
    date,
    perAgent: Object.fromEntries(
      taskAgents.map((agentId) => [agentId, perDay.get(`${agentId}\0${date}`) ?? 0]),
    ),
  }))

  const waitInterval = (approval: ReportApproval): Interval => {
    const start = Date.parse(approval.createdAt)
    const end = approval.decidedAt ?? approval.closedAt
    return [start, end ? Date.parse(end) : approval.status === 'pending' ? input.now : start]
  }
  const timeSplit = agentIds.map((agentId) => {
    const working = merge(
      allRuns
        .filter((run) => run.agentId === agentId && run.work !== false)
        .flatMap((run): Interval[] => stretchesOf(run, input.now)),
      from,
      to,
    )
    const mine = input.facts.tasks.filter((task) => task.assignee === agentId)
    // Disjoint categories, by precedence: working > waiting on you > waiting on another agent.
    // Guardian reviews of a gate happen inside an active run, so they stay "working".
    const youSet = subtract(
      merge(
        [
          ...input.approvals
            .filter((a) => a.agentId === agentId && a.stage === 'human' && a.visible)
            .map(waitInterval),
          ...mine.flatMap((task) => blockedWaits(task, input.now)),
        ],
        from,
        to,
      ),
      working,
    )
    const agentSet = subtract(
      merge(
        input.facts.tasks.flatMap((task) => agentWaits(task, agentId, input.now)),
        from,
        to,
      ),
      merge([...working, ...youSet], from, to),
    )
    const waitingYou = measure(youSet)
    const waitingAgent = measure(agentSet)
    const [workingPct, waitingOnYouPct, waitingOnAgentPct] = percentages([
      measure(working),
      waitingYou,
      waitingAgent,
    ])
    return {
      agentId,
      workingPct: workingPct!,
      waitingOnYouPct: waitingOnYouPct!,
      waitingOnAgentPct: waitingOnAgentPct!,
    }
  })

  const byAgent = agentIds.map((agentId) => {
    const mine = finished.filter((task) => task.assignee === agentId)
    const mineReviewed = mine.filter(reviewed)
    return {
      agentId,
      finished: mine.length,
      runs: runs.filter((run) => run.agentId === agentId).length,
      medianSec: median(mine.map(seconds)),
      firstPassRate: rate(mineReviewed.filter(passedFirst).length, mineReviewed.length),
      spendUsd: money(input.facts.spendUsd[agentId] ?? null),
      cacheHitRate: cacheHitRate(input.facts.cache?.[agentId]),
    }
  })
  const knownCache = agentIds.flatMap((agentId) => input.facts.cache?.[agentId] ?? [])

  const asked = input.approvals.filter((approval) => {
    const at = Date.parse(approval.createdAt)
    return approval.stage === 'human' && approval.visible && at >= from && at <= to
  })
  const approved = asked.filter((approval) => approval.status === 'approved').length
  const denied = asked.filter((approval) => approval.status === 'denied').length
  const waits = asked.flatMap((approval) =>
    approval.decisionBy === 'you' && approval.decidedAt
      ? [(Date.parse(approval.decidedAt) - Date.parse(approval.createdAt)) / 1000]
      : [],
  )
  const insight =
    asked.length >= 5 && approved === asked.length
      ? `You approved all ${asked.length} requests; a standing Go-ahead rule could save the interruptions.`
      : asked.length >= 5 && denied / asked.length >= 0.5
        ? `You denied ${denied} of ${asked.length} requests; consider tightening what those agents may try.`
        : null

  const doneReviewed = finished.filter(reviewed)
  const totals = {
    tasksFinished: finished.length,
    runs: runs.length,
    firstPassRate: rate(doneReviewed.filter(passedFirst).length, doneReviewed.length),
    medianTaskSec: median(finished.map(seconds)),
    // One unknown component makes the total unknown: a sum of the known ones would pass as complete.
    spendUsd: agentIds.some((agentId) => (input.facts.spendUsd[agentId] ?? null) === null)
      ? null
      : money(sum(agentIds.map((agentId) => input.facts.spendUsd[agentId] ?? null))),
    cacheHitRate: cacheHitRate({
      read: knownCache.reduce((total, tokens) => total + tokens.read, 0),
      total: knownCache.reduce((total, tokens) => total + tokens.total, 0),
    }),
  }
  const unattributed = input.attempts
    ? (() => {
        const mine = input.attempts.filter((attempt) => attempt.agentId === null)
        const started = mine.filter((attempt) => {
          const at = Date.parse(attempt.startedAt)
          return at >= from && at <= to
        })
        const working = merge(
          mine
            .filter((attempt) => attempt.evidence === 'proven')
            .flatMap((attempt): Interval[] => stretchesOf(attempt, input.now)),
          from,
          to,
        )
        return { runs: started.length, workingSec: Math.round(measure(working) / 1000) }
      })()
    : undefined
  const when =
    input.range === 'custom'
      ? input.custom!.from === input.custom!.to
        ? `on ${input.custom!.from}`
        : `from ${input.custom!.from} to ${input.custom!.to}`
      : RANGE_WORDS[input.range]
  const summary = finished.length
    ? `${finished.length} ${finished.length === 1 ? 'task' : 'tasks'} finished ${when}` +
      (totals.medianTaskSec === null ? '.' : `, typically in ${duration(totals.medianTaskSec)}.`)
    : `No tasks finished ${when}.`

  return {
    range: input.range,
    summary,
    totals,
    byDay,
    timeSplit,
    byAgent,
    // Filled in by the route (it needs 30 days of runs and cost readings whatever the range is).
    trend: [],
    approvals: {
      asked: asked.length,
      approved,
      denied,
      medianWaitSec: median(waits),
      insight,
    },
    ...(unattributed ? { unattributed } : {}),
  }
}

const RunRowSchema = z.object({
  profile: z.string(),
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
})
const ApprovalReportRowSchema = z.object({
  profile: z.string(),
  stage: z.enum(['guardian', 'human']),
  visible: z.int(),
  status: z.string(),
  decision_by: z.string().nullable(),
  created_at: z.iso.datetime(),
  decided_at: z.iso.datetime().nullable(),
  closed_at: z.iso.datetime().nullable(),
})

/** Runs and approvals that overlap the window (so open intervals that started earlier still count). */
export function readReportRows(
  sqlite: DatabaseSync,
  from: number,
  to: number,
  withAttempts = kanbanAttemptsEnabled(),
): { runs: ReportRun[]; approvals: ReportApproval[]; attempts?: ReportAttempt[] } {
  const fromIso = new Date(from).toISOString()
  const toIso = new Date(to).toISOString()
  const runs = sqlite
    .prepare(
      `SELECT profile, started_at, ended_at FROM runs
       WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`,
    )
    .all(toIso, fromIso)
    .map((row) => RunRowSchema.parse(row))
    .map((row) => ({ agentId: row.profile, startedAt: row.started_at, endedAt: row.ended_at }))
  const approvals = sqlite
    .prepare(
      `SELECT profile, stage, visible, status, decision_by, created_at, decided_at, closed_at FROM approvals
       WHERE created_at <= ? AND (COALESCE(decided_at, closed_at) IS NULL OR COALESCE(decided_at, closed_at) >= ?)`,
    )
    .all(toIso, fromIso)
    .map((row) => ApprovalReportRowSchema.parse(row))
    .map((row) => ({
      agentId: row.profile,
      stage: row.stage,
      visible: row.visible === 1,
      status: row.status,
      decisionBy: row.decision_by,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      closedAt: row.closed_at,
    }))
  if (!withAttempts) return { runs, approvals }
  const attempts = listAttempts(sqlite, { since: fromIso, until: toIso, excludeCopies: true }).map(
    (attempt): ReportAttempt => ({
      agentId: attempt.agentId,
      startedAt: attempt.startedAt,
      endedAt: attempt.endedAt ?? attempt.observationEndedAt,
      evidence: attempt.evidence,
      observed: attempt.observations,
    }),
  )
  return { runs, approvals, attempts }
}
