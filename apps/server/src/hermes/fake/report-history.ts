import type { KanbanTaskFact, ReportApproval, ReportRun } from '../../domain/reports.ts'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const HISTORY_DAYS = 30

export interface FakeReportHistory {
  tasks: KanbanTaskFact[]
  runs: ReportRun[]
  approvals: ReportApproval[]
  /** Dollars per day per agent, so spend grows with the window. */
  spendPerDay: Record<string, number>
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

// Per agent: share of the day's tasks, minutes a task takes, chance a review sends it back, spend per day.
const PROFILES: Record<
  string,
  { weight: number; minutes: [number, number]; sendBack: number; spend: number }
> = {
  lead: { weight: 2, minutes: [10, 30], sendBack: 0.1, spend: 0.6 },
  builder: { weight: 5, minutes: [20, 60], sendBack: 0.3, spend: 1.9 },
  designer: { weight: 3, minutes: [15, 45], sendBack: 0.2, spend: 1.1 },
  reviewer: { weight: 2, minutes: [5, 20], sendBack: 0, spend: 0.8 },
}
const FALLBACK = { weight: 1, minutes: [15, 40] as [number, number], sendBack: 0.2, spend: 0.5 }

/**
 * A deterministic, plausible 30 days of finished work relative to `now`: more on weekdays than weekends,
 * dependency waits, reviews with send-backs, a few blocked spells, runs and your approvals.
 * Neutral agents only; the same day always produces the same history.
 */
export function fakeReportHistory(now: number, agentIds: string[]): FakeReportHistory {
  const today = Math.floor(now / DAY) * DAY
  const pool = agentIds.flatMap((id) =>
    Array.from({ length: (PROFILES[id] ?? FALLBACK).weight }, () => id),
  )
  const tasks: KanbanTaskFact[] = []
  const runs: ReportRun[] = []
  const approvals: ReportApproval[] = []
  if (pool.length === 0) return { tasks, runs, approvals, spendPerDay: {} }

  for (let back = HISTORY_DAYS - 1; back >= 0; back--) {
    const dayStart = today - back * DAY
    const rand = mulberry32(Math.floor(dayStart / DAY))
    const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1))
    const weekend = [0, 6].includes(new Date(dayStart).getUTCDay())
    const count = weekend ? between(1, 2) : between(3, 6)
    for (let n = 0; n < count; n++) {
      const agentId = pool[between(0, pool.length - 1)]!
      const profile = PROFILES[agentId] ?? FALLBACK
      // Today's work finishes before "now" so the Today range is never empty.
      const latest = back === 0 ? Math.max(61, Math.floor((now - dayStart) / MIN)) : 18 * 60
      const completedAt = dayStart + between(Math.min(9 * 60, latest - 1), latest) * MIN
      if (completedAt > now) continue
      const work = between(...profile.minutes) * MIN
      const hasParents = rand() < 0.3
      const depWait = hasParents ? between(5, 25) * MIN : 0
      const createdAt = completedAt - work - depWait
      const reviewed = agentId !== 'reviewer' && rand() < 0.85
      const sentBack = reviewed && rand() < profile.sendBack * 1.5
      const events: KanbanTaskFact['events'] = []
      if (hasParents) events.push({ kind: 'promoted', at: createdAt + depWait })
      const start = createdAt + depWait
      if (rand() < 0.12) {
        events.push({ kind: 'blocked', at: start + 5 * MIN })
        events.push({ kind: 'unblocked', at: start + between(15, 90) * MIN })
      }
      const askedAt = completedAt - between(6, 14) * MIN
      if (reviewed) {
        if (sentBack) {
          events.push({ kind: 'review_requested', at: askedAt - 12 * MIN })
          events.push({ kind: 'changes_requested', at: askedAt - 4 * MIN })
        }
        events.push({ kind: 'review_requested', at: askedAt })
      }
      events.push({ kind: 'completed', at: completedAt })
      events.sort((a, b) => a.at - b.at)
      tasks.push({
        id: `history-${Math.floor(dayStart / DAY)}-${n}`,
        assignee: agentId,
        status: 'done',
        createdAt,
        completedAt,
        hasParents,
        events,
      })
      // Two runs per task covering most of the working time.
      const span = Math.max(MIN, work - 4 * MIN)
      runs.push(
        { agentId, startedAt: iso(start), endedAt: iso(start + Math.floor(span * 0.55)) },
        {
          agentId,
          startedAt: iso(start + Math.floor(span * 0.65)),
          endedAt: iso(Math.min(completedAt, start + span)),
        },
      )
      if (reviewed && agentIds.includes('reviewer') && agentId !== 'reviewer') {
        runs.push({
          agentId: 'reviewer',
          startedAt: iso(askedAt + MIN),
          endedAt: iso(askedAt + 6 * MIN),
        })
      }
      // Some steps need your go-ahead; mostly quick, sometimes it waits overnight.
      if (agentId !== 'reviewer' && rand() < 0.45) {
        const asked = start + between(2, Math.max(3, Math.floor(work / MIN) - 3)) * MIN
        const slow = rand() < 0.08
        const decided = asked + (slow ? between(4, 9) * HOUR : between(1, 7) * MIN)
        const denied = rand() < 0.14
        if (decided <= now)
          approvals.push({
            agentId,
            stage: 'human',
            visible: true,
            status: denied ? 'denied' : 'approved',
            decisionBy: 'you',
            createdAt: iso(asked),
            decidedAt: iso(decided),
            closedAt: null,
          })
      }
    }
  }
  return {
    tasks,
    runs,
    approvals,
    spendPerDay: Object.fromEntries(
      agentIds.map((id, i) => [id, (PROFILES[id] ?? FALLBACK).spend + i * 0.05]),
    ),
  }
}
