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
  let open = false
  if (run.session_id !== null)
    open =
      sqlite
        .prepare(
          `SELECT 1 FROM runs WHERE session_id = ? AND id != ? AND status NOT IN ('completed','failed','cancelled','interrupted') LIMIT 1`,
        )
        .get(run.session_id, attempt.run_id) !== undefined
  return { usd: run.cost_usd, complete: terminal && run.cost_usd !== null && !open }
}

export function budgetView(sqlite: DatabaseSync, o: OrchRow): BudgetView {
  let settled = 0
  let provisional = 0
  let reserved = 0
  let unknownSpend = false
  let allSettled = true
  for (const attempt of attemptsOf(sqlite, o.id)) {
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
    if (ended && attempt.spend_usd === null) unknownSpend = true
  }
  for (const step of stepsOf(sqlite, o.id))
    if (step.status === 'pending_gate' || step.status === 'queued') reserved += step.estimate_usd
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
