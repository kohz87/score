export const NO_VALUE = '—'

/** Whole minutes for the table and totals; short spans in seconds, long ones in hours. */
export function formatDuration(sec: number | null): string {
  if (sec === null) return NO_VALUE
  if (sec < 60) return `${Math.round(sec)} sec`
  if (sec < 5400) return `${Math.round(sec / 60)} min`
  return `${Math.round(sec / 360) / 10} h`
}

export function formatPercent(rate: number | null, empty = NO_VALUE): string {
  return rate === null ? empty : `${Math.round(rate * 100)}%`
}

export function formatUsd(usd: number | null): string {
  return usd === null ? NO_VALUE : `$${usd.toFixed(2)}`
}
