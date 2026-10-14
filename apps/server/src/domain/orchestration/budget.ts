import type { BudgetView } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { attemptsOf, stepsOf, type AttemptRow, type OrchRow } from './store.ts'

// Budgets (design v2 "Budget" + v3 "Accounting completeness"): estimates are reserved once (a step at queueing, a lead
// turn at its claim) and travel with the item until its attempt is settled. Spend is complete only for a terminated
// attempt whose session has no open run; until then it is provisional and budgets count provisional + reservations.
// Unknown spend is never zero.

export interface SpendReading {
  usd: number | null
  complete: boolean
}
export type SpendReader = (sqlite: DatabaseSync, attempt: AttemptRow) => SpendReading

const RunSpendSchema = z.object({
  status: z.string(),
  session_id: z.string().nullable(),
  cost_usd: z.number().nullable(),
})
const TERMINAL_RUN = ['completed', 'failed', 'cancelled', 'interrupted']

/** Reads what Score observed for the attempt's own run. Lineage forks (compression continuations) are not visible here. */
export const runSpendReader: SpendReader = (sqlite, attempt) => {
  if (attempt.run_id === null) return { usd: null, complete: false }
  const row = sqlite
    .prepare('SELECT status, session_id, cost_usd FROM runs WHERE id = ?')
    .get(attempt.run_id)
  if (row === undefined) return { usd: null, complete: false }
  const run = RunSpendSchema.parse(row)
  const terminal = TERMINAL_RUN.includes(run.status)
  // Closure must be shown, never assumed: an unknown session, or a sibling run in it that has not ended with evidence
  // (running, cancelled, interrupted), keeps the spend provisional. Compression continuations in other sessions cannot
  // be seen from here, so they are an open item for the adapter (documented in the contract).
  const open =
    run.session_id === null ||
    sqlite
      .prepare(
        `SELECT 1 FROM runs WHERE session_id = ? AND id != ? AND status NOT IN ('completed','failed') LIMIT 1`,
      )
      .get(run.session_id, attempt.run_id) !== undefined
  return { usd: run.cost_usd, complete: terminal && run.cost_usd !== null && !open }
}

/**
 * v8.1 item 4: an adapter evidence contract instead of a settlement claim. Today's Hermes adapter cannot prove that a
 * session's compression lineage is complete, so live spend is never settled: it stays provisional and reservations stay
 * held until the run ends. The fake adapter can report full evidence (tests).
 */
export interface SpendEvidence {
  attributed: boolean
  lineageComplete: boolean
  fresh: boolean
  costScope: 'dollars' | 'tokens' | 'none'
}

export function spendEvidence(
  sqlite: DatabaseSync,
  attempt: AttemptRow,
  lineageProvable: boolean,
): SpendEvidence {
  if (attempt.run_id === null)
    return { attributed: false, lineageComplete: false, fresh: false, costScope: 'none' }
  const row = sqlite
    .prepare(
      'SELECT status, session_id, cost_usd, input_tokens, output_tokens FROM runs WHERE id = ?',
    )
    .get(attempt.run_id) as
    | {
        status: string
        session_id: string | null
        cost_usd: number | null
        input_tokens: number | null
        output_tokens: number | null
      }
    | undefined
  if (!row) return { attributed: false, lineageComplete: false, fresh: false, costScope: 'none' }
  const open =
    row.session_id === null ||
    sqlite
      .prepare(
        `SELECT 1 FROM runs WHERE session_id = ? AND id != ? AND status NOT IN ('completed','failed') LIMIT 1`,
      )
      .get(row.session_id, attempt.run_id) !== undefined
  return {
    attributed: row.session_id !== null,
    lineageComplete: lineageProvable && !open,
    fresh: TERMINAL_RUN.includes(row.status),
    costScope: row.cost_usd !== null ? 'dollars' : row.input_tokens !== null ? 'tokens' : 'none',
  }
}

/** The reader the executor uses: a live adapter's spend is never settled (see `SpendEvidence`). */
export const makeSpendReader =
  (live: boolean): SpendReader =>
  (sqlite, attempt) => {
    const reading = runSpendReader(sqlite, attempt)
    return live ? { ...reading, complete: false } : reading
  }

/**
 * An attempt as the run facts say it is NOW (F1 #1): a run row can commit its terminal state and cost before the
 * executor reconciles the attempt, so a release decision that read the attempt alone would miss a sibling's spend. An
 * attempt not yet settled whose own run is terminal counts as ended, with the run's cost (unknown when it has none).
 */
function freshAttempt(sqlite: DatabaseSync, attempt: AttemptRow): AttemptRow {
  if (
    attempt.settled ||
    !['send_started', 'running', 'unknown', 'abandoned'].includes(attempt.state)
  )
    return attempt
  const runId =
    attempt.run_id ??
    (
      sqlite
        .prepare(
          'SELECT run_id FROM orc_generations WHERE attempt_id = ? AND generation = ? AND run_id IS NOT NULL',
        )
        .get(attempt.id, attempt.dispatch_generation) as { run_id: string } | undefined
    )?.run_id
  if (runId === undefined || runId === null) return attempt
  const row = sqlite.prepare('SELECT status, cost_usd FROM runs WHERE id = ?').get(runId) as
    { status: string; cost_usd: number | null } | undefined
  if (!row || !TERMINAL_RUN.includes(row.status)) return attempt
  return {
    ...attempt,
    state:
      attempt.state === 'send_started' || attempt.state === 'running'
        ? 'terminated'
        : attempt.state,
    spend_usd: row.cost_usd ?? attempt.spend_usd,
  }
}

/**
 * A coding generation that provably launched nothing (F2 #1): its launch was revoked before `releasing`, it was closed
 * by `send_closed`, or the run ended on a refusal receipt. Such an attempt spent exactly nothing, so a missing cost is
 * not an unknown one.
 */
function provenUnsent(sqlite: DatabaseSync, attempt: AttemptRow): boolean {
  const generation = sqlite
    .prepare(
      'SELECT launch_id, run_id, closed_cause FROM orc_generations WHERE attempt_id = ? AND generation = ?',
    )
    .get(attempt.id, attempt.dispatch_generation) as
    { launch_id: string; run_id: string | null; closed_cause: string | null } | undefined
  if (!generation) return false
  if (generation.closed_cause !== null) return true
  const launch = sqlite
    .prepare('SELECT revoked, may_have_executed FROM coding_launches WHERE launch_id = ?')
    .get(generation.launch_id) as { revoked: number; may_have_executed: number } | undefined
  if (launch && launch.revoked === 1 && launch.may_have_executed === 0) return true
  const runId = attempt.run_id ?? generation.run_id
  return (
    runId !== null &&
    sqlite.prepare('SELECT 1 FROM coding_refusals WHERE run_id = ?').get(runId) !== undefined
  )
}

export function budgetView(
  sqlite: DatabaseSync,
  o: OrchRow,
  options: { fresh?: boolean } = {},
): BudgetView {
  const attemptRows = attemptsOf(sqlite, o.id)
  const attempts = options.fresh ? attemptRows.map((a) => freshAttempt(sqlite, a)) : attemptRows
  let settled = 0
  let provisional = 0
  let reserved = 0
  let unknownSpend = false
  let allSettled = true
  for (const attempt of attempts) {
    if (attempt.state === 'refused') continue
    if (attempt.state === 'created') {
      reserved += attempt.reserved_usd
      allSettled = false
      continue
    }
    const ended = ['terminated', 'unknown', 'abandoned'].includes(attempt.state)
    if (attempt.settled) {
      settled += attempt.spend_usd ?? 0
      continue
    }
    allSettled = false
    provisional += attempt.spend_usd ?? 0
    if (attempt.state !== 'abandoned') reserved += attempt.reserved_usd
    // An ended attempt that reported no spend leaves the total unknown (never zero).
    if (ended && attempt.spend_usd === null && !provenUnsent(sqlite, attempt)) unknownSpend = true
  }
  // A step whose attempt is suspended (7.7b K2/A1) keeps its reservation on that attempt through re-gating and
  // re-admission: the step's own estimate is not counted a second time while it waits.
  const suspendedSteps = new Set(
    attempts
      .filter((attempt) => attempt.suspended && attempt.step_id !== null)
      .map((attempt) => attempt.step_id),
  )
  for (const step of stepsOf(sqlite, o.id))
    if (
      (step.status === 'pending_gate' || step.status === 'queued') &&
      !suspendedSteps.has(step.id)
    )
      reserved += step.estimate_usd
  const committed = settled + provisional + reserved
  return {
    limitUsd: o.budget_usd,
    settledUsd: round(settled),
    provisionalUsd: round(provisional),
    reservedUsd: round(reserved),
    remainingUsd: o.budget_usd === null ? null : round(o.budget_usd - committed),
    unknownSpend,
    complete: allSettled,
  }
}

/** Committed total: what the budget is checked against. */
export const committedUsd = (view: BudgetView): number =>
  view.settledUsd + view.provisionalUsd + view.reservedUsd

export const canReserve = (view: BudgetView, estimate: number): boolean =>
  view.limitUsd === null || committedUsd(view) + estimate <= view.limitUsd + 1e-9

export const overBudget = (view: BudgetView): boolean =>
  view.limitUsd !== null && committedUsd(view) > view.limitUsd + 1e-9

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** Where an attempt's cost comes from: `hermes` for the lead and Hermes steps, the CLI's runtime for a coding step. */
export const costSourceOf = (attempt: Pick<AttemptRow, 'kind' | 'runtime'>): string =>
  attempt.kind === 'step' ? attempt.runtime : 'hermes'

/** The sources of the attempts that ended without a recorded cost (7.7b §8: unknown cost keeps its provenance). */
export function unknownCostSources(
  sqlite: DatabaseSync,
  o: OrchRow,
  options: { fresh?: boolean } = {},
): Set<string> {
  const sources = new Set<string>()
  for (const read of attemptsOf(sqlite, o.id)) {
    const attempt = options.fresh ? freshAttempt(sqlite, read) : read
    if (attempt.state === 'refused' || attempt.settled) continue
    if (
      ['terminated', 'unknown', 'abandoned'].includes(attempt.state) &&
      attempt.spend_usd === null
    )
      sources.add(costSourceOf(attempt))
  }
  return sources
}

/**
 * Whether an unknown cost nobody accepted pauses the run: only with a dollar budget set (today's rule), and only for a
 * source the person hasn't accepted. `acceptUnknownSpend` accepts every source.
 */
export function unknownCostBlocks(
  sqlite: DatabaseSync,
  o: OrchRow,
  view: BudgetView,
  options: { fresh?: boolean } = {},
): boolean {
  if (view.limitUsd === null || !view.unknownSpend || o.accepted_unknown_spend) return false
  const accepted = new Set(o.accepted_unknown_cost)
  for (const source of unknownCostSources(sqlite, o, options))
    if (!accepted.has(source)) return true
  return false
}
