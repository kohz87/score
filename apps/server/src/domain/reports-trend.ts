import type { DatabaseSync } from 'node:sqlite'
import type { Reports } from '@score/contract'
import { addDays, reportWindow, startOfDay, type ReportRun } from './reports.ts'
import { profileSpendInWindow, type SessionCost } from './spend.ts'

export const TREND_DAYS = 30
export type Trend = Reports['trend']

const dayOf = (ms: number, tz: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms)

/** Window of the trend: the last 30 local days ending today. */
export function trendWindow(now: number, tz?: string) {
  return reportWindow('30d', now, tz)
}

/**
 * Runs started and spend per local day. Spend is the sum over agents of that day's share of each session's cost
 * (Score's own snapshots); a day with any unreadable agent is null, never a partial sum. `costs` is omitted when the
 * adapter has no cost data, so every day is unknown.
 */
export function computeTrend(input: {
  now: number
  tz: string
  runs: ReportRun[]
  costs?: Record<string, SessionCost[]>
  /** Every agent that should have a reading: one missing from `costs` (unreadable) makes the spend unknown. */
  agentIds?: string[]
  sqlite?: DatabaseSync
  /** Demo adapter: one value per day, oldest first, used when there are no cost readings. */
  demoSpendUsd?: number[]
}): Trend {
  const { days } = trendWindow(input.now, input.tz)
  const runsPerDay = new Map<string, number>()
  for (const run of input.runs) {
    const day = dayOf(Date.parse(run.startedAt), input.tz)
    runsPerDay.set(day, (runsPerDay.get(day) ?? 0) + 1)
  }
  return days.map((date, index) => {
    let spendUsd: number | null = input.costs ? null : (input.demoSpendUsd?.[index] ?? null)
    if (input.costs && input.sqlite) {
      const from = startOfDay(date, input.tz)
      const to = Math.min(input.now, startOfDay(addDays(date, 1), input.tz) - 1)
      let total: number | null = (input.agentIds ?? []).some((id) => !(id in input.costs!))
        ? null
        : 0
      for (const [profile, sessions] of total === null ? [] : Object.entries(input.costs)) {
        // A session that had not started yet cannot have spent anything that day.
        const existing = sessions.filter((session) => session.startedAt <= to)
        const spend = profileSpendInWindow(input.sqlite, profile, existing, from, to)
        if (spend === null || total === null) {
          total = null
          break
        }
        total += spend
      }
      spendUsd = total === null ? null : Math.round(total * 1e6) / 1e6
    }
    return { date, runs: runsPerDay.get(date) ?? 0, spendUsd }
  })
}
