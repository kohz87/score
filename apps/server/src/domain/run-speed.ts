import type { DatabaseSync } from 'node:sqlite'
import type { MessageSpeed } from '@score/contract'

/** Shorter spans say nothing about throughput (a few tokens arriving at once). */
const MIN_SPAN_MS = 500

export interface SpeedInput {
  startedAt: string
  firstOutputAt: string | null
  endedAt: string | null
  outputTokens: number | null
}

/** Notes the first reply text of a run. Set once, never moved. */
export function markFirstOutput(sqlite: DatabaseSync, runId: string, now: string): void {
  sqlite
    .prepare('UPDATE runs SET first_output_at = ? WHERE id = ? AND first_output_at IS NULL')
    .run(now, runId)
}

/** A CLI's own time to first token replaces Score's measurement: first output = start + ttft. */
export function applyCliTtft(
  sqlite: DatabaseSync,
  runId: string,
  ttftMs: number,
  /** When the run ends, if the row doesn't say yet (the terminal observation sets it right after). */
  endedAt?: string,
): void {
  if (!Number.isFinite(ttftMs) || ttftMs < 0) return
  const row = sqlite.prepare('SELECT started_at, ended_at FROM runs WHERE id = ?').get(runId) as
    { started_at: string; ended_at: string | null } | undefined
  const start = row ? Date.parse(row.started_at) : NaN
  if (Number.isNaN(start)) return
  const first = start + Math.round(ttftMs)
  // A figure landing after the run ended is not credible: keep Score's own measurement.
  const end = Date.parse(row?.ended_at ?? endedAt ?? '')
  if (!Number.isNaN(end) && first > end) return
  sqlite
    .prepare('UPDATE runs SET first_output_at = ? WHERE id = ?')
    .run(new Date(first).toISOString(), runId)
}

/** Derived figures; anything missing is null. All null = nothing measured. */
export function deriveSpeed(run: SpeedInput): MessageSpeed {
  const started = Date.parse(run.startedAt)
  const first = run.firstOutputAt ? Date.parse(run.firstOutputAt) : NaN
  const ended = run.endedAt ? Date.parse(run.endedAt) : NaN
  const ttft = Number.isNaN(started) || Number.isNaN(first) ? NaN : first - started
  const span = Number.isNaN(first) || Number.isNaN(ended) ? NaN : ended - first
  const tokens = run.outputTokens
  return {
    ttftMs: ttft >= 0 ? ttft : null,
    tokensPerSecond:
      tokens !== null && tokens > 0 && span >= MIN_SPAN_MS ? tokens / (span / 1000) : null,
    outputTokens: tokens,
  }
}

/** The stored JSON for a finished reply's run, or null when nothing was measured. */
export function runSpeedJson(sqlite: DatabaseSync, runId: string): string | null {
  const row = sqlite
    .prepare('SELECT started_at, first_output_at, ended_at, output_tokens FROM runs WHERE id = ?')
    .get(runId) as
    | {
        started_at: string
        first_output_at: string | null
        ended_at: string | null
        output_tokens: number | null
      }
    | undefined
  if (!row) return null
  const speed = deriveSpeed({
    startedAt: row.started_at,
    firstOutputAt: row.first_output_at,
    endedAt: row.ended_at,
    outputTokens: row.output_tokens,
  })
  return hasSpeed(speed) ? JSON.stringify(speed) : null
}

export function hasSpeed(speed: MessageSpeed): boolean {
  return speed.ttftMs !== null || speed.tokensPerSecond !== null || speed.outputTokens !== null
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

interface SpeedRunRow {
  profile: string
  started_at: string
  first_output_at: string | null
  ended_at: string | null
  output_tokens: number | null
}

/** Median TTFT and tokens/s per agent over the runs that started in [from, to]. */
export function speedByAgent(
  sqlite: DatabaseSync,
  from: number,
  to: number,
): {
  agentId: string
  runs: number
  medianTtftMs: number | null
  medianTokensPerSecond: number | null
}[] {
  const rows = sqlite
    .prepare(
      `SELECT profile, started_at, first_output_at, ended_at, output_tokens FROM runs
       WHERE started_at >= ? AND started_at <= ? AND first_output_at IS NOT NULL`,
    )
    .all(new Date(from).toISOString(), new Date(to).toISOString()) as unknown as SpeedRunRow[]
  const byAgent = new Map<string, { ttft: number[]; tps: number[]; runs: number }>()
  for (const row of rows) {
    const speed = deriveSpeed({
      startedAt: row.started_at,
      firstOutputAt: row.first_output_at,
      endedAt: row.ended_at,
      outputTokens: row.output_tokens,
    })
    if (speed.ttftMs === null && speed.tokensPerSecond === null) continue
    const entry = byAgent.get(row.profile) ?? { ttft: [], tps: [], runs: 0 }
    entry.runs++
    if (speed.ttftMs !== null) entry.ttft.push(speed.ttftMs)
    if (speed.tokensPerSecond !== null) entry.tps.push(speed.tokensPerSecond)
    byAgent.set(row.profile, entry)
  }
  return [...byAgent].map(([agentId, entry]) => ({
    agentId,
    runs: entry.runs,
    medianTtftMs: median(entry.ttft),
    medianTokensPerSecond: median(entry.tps),
  }))
}
