import type { Reports, ReportRange } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

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
}

export interface ReportRun {
  agentId: string
  startedAt: string
  endedAt: string | null
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

export interface ReportInput {
  range: ReportRange
  now: number
  tz?: string
  agentIds: string[]
  runs: ReportRun[]
  approvals: ReportApproval[]
  facts: ReportFacts
}

const DAYS: Record<ReportRange, number> = { today: 1, '7d': 7, '30d': 30 }

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

function dayKey(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms)
}

function offsetMs(ms: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  )
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return asUtc - Math.floor(ms / 1000) * 1000
}

function startOfDay(key: string, tz: string): number {
  const guess = Date.parse(`${key}T00:00:00Z`)
  const first = guess - offsetMs(guess, tz)
  return guess - offsetMs(first, tz)
}

function addDays(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

export function reportWindow(range: ReportRange, now: number, tz = localTimeZone()): ReportWindow {
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

const RANGE_WORDS: Record<ReportRange, string> = {
  today: 'today',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
}

function duration(sec: number): string {
  if (sec < 90) return `${Math.round(sec)} seconds`
  if (sec < 5400) return `${Math.round(sec / 60)} minutes`
  return `${Math.round(sec / 360) / 10} hours`
}

export function computeReports(input: ReportInput): Reports {
  const tz = input.tz ?? localTimeZone()
  const { from, to, days } = reportWindow(input.range, input.now, tz)
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
  const runs = input.runs.filter((run) => {
    const startedAt = Date.parse(run.startedAt)
    return startedAt >= from && startedAt <= to
  })
  for (const run of runs) agents.add(run.agentId)
  const agentIds = [...agents].sort()

  const taskAgents = [
    ...new Set(finished.flatMap((task) => (task.assignee ? [task.assignee] : []))),
  ].sort()
  const byDay = days.map((date) => ({
    date,
    perAgent: Object.fromEntries(
      taskAgents.map((agentId) => [
        agentId,
        finished.filter((task) => task.assignee === agentId && dayKey(at(task), tz) === date)
          .length,
      ]),
    ),
  }))

  const waitInterval = (approval: ReportApproval): Interval => {
    const start = Date.parse(approval.createdAt)
    const end = approval.decidedAt ?? approval.closedAt
    return [start, end ? Date.parse(end) : approval.status === 'pending' ? input.now : start]
  }
  const timeSplit = agentIds.map((agentId) => {
    const working = merge(
      input.runs
        .filter((run) => run.agentId === agentId)
        .map((run): Interval => [
          Date.parse(run.startedAt),
          run.endedAt ? Date.parse(run.endedAt) : input.now,
        ]),
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
    }
  })

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
  }
  const when = RANGE_WORDS[input.range]
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
    approvals: {
      asked: asked.length,
      approved,
      denied,
      medianWaitSec: median(waits),
      insight,
    },
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
): { runs: ReportRun[]; approvals: ReportApproval[] } {
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
  return { runs, approvals }
}
