import type { ReportRange } from '@score/contract'
import type { CustomDays, ReportWindow } from './reports-types.ts'

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

export function dayKey(ms: number, tz: string): string {
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
