// PLAN 5.39: one line of facts when a run ends. A fact that Score doesn't know is left out; nothing is invented, and a
// count of zero says nothing worth a line.

export type SummaryFacts = {
  toolCalls?: number | null
  steps?: number | null
  handoffs?: number | null
  /** Approvals or gates that were decided during the run. */
  approvals?: number | null
  /** The context was compacted, with its size (in tokens) before and after. */
  compacted?: { before: number; after: number } | null
  spendUsd?: number | null
  /** The spend isn't settled: Hermes hasn't reported a final cost. */
  spendEstimated?: boolean
  durationSec?: number | null
}

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
      : String(n)

export function spendText(usd: number, estimated: boolean): string {
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}${estimated ? ' (estimated)' : ''}`
}

export function durationText(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} seconds`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

const positive = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0

/** The summary line, or null when nothing is known. */
export function summaryLine(facts: SummaryFacts): string | null {
  const parts: string[] = []
  if (positive(facts.toolCalls)) parts.push(count(facts.toolCalls, 'tool call', 'tool calls'))
  if (positive(facts.steps)) parts.push(count(facts.steps, 'step', 'steps'))
  if (positive(facts.handoffs)) parts.push(count(facts.handoffs, 'hand-off', 'hand-offs'))
  if (positive(facts.approvals)) parts.push(count(facts.approvals, 'approval', 'approvals'))
  if (facts.compacted)
    parts.push(
      `context compacted ${tokens(facts.compacted.before)} → ${tokens(facts.compacted.after)}`,
    )
  if (typeof facts.spendUsd === 'number' && Number.isFinite(facts.spendUsd))
    parts.push(spendText(facts.spendUsd, facts.spendEstimated ?? false))
  if (positive(facts.durationSec)) parts.push(durationText(facts.durationSec))
  return parts.length > 0 ? parts.join(' · ') : null
}

/** Seconds between two ISO times, or null when either is missing or the order is wrong. */
export function secondsBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null
  const seconds = (Date.parse(to) - Date.parse(from)) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}
