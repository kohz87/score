import type { Reports } from '@score/contract'
import {
  agentWaits,
  blockedWaits,
  cacheHitRate,
  type Interval,
  measure,
  median,
  merge,
  money,
  percentages,
  rate,
  subtract,
  sum,
} from './reports-metrics.ts'
import { dayKey, localTimeZone, reportWindow } from './reports-time.ts'
import type { KanbanTaskFact, ReportApproval, ReportInput, ReportRun } from './reports-types.ts'

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
