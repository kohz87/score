import type { DatabaseSync } from 'node:sqlite'
import type { ExchangeAction } from '@score/contract'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { release } from './budget.ts'
import { stopExchanges } from './exchange-stops.ts'
import { exchangeRow, jobRow, updateExchange } from './store.ts'

/** The lead's turn on a budget pause ended: extend once (up to the job's exchange budget), stop, or back to the person. */
export function leadDecision(
  sqlite: DatabaseSync,
  exchangeId: string,
  lead: string,
  decision: ExchangeAction | undefined,
  now: string,
): DomainEventDraft[] {
  const exchange = exchangeRow(sqlite, exchangeId)
  if (!exchange || exchange.state !== 'paused_budget') return []
  if (decision?.action === 'extend') {
    const job = jobRow(sqlite, exchange.job_id)!
    const turns = Math.min(decision.turns, job.exchange_budget)
    const drafts = updateExchange(sqlite, exchangeId, { lead_extended: 1 }, now)
    if (exchange.pause_reason === 'job_limit')
      sqlite
        .prepare('UPDATE jobs SET job_turn_limit = job_turn_limit + ? WHERE id = ?')
        .run(turns, exchange.job_id)
    else
      drafts.push(...updateExchange(sqlite, exchangeId, { budget: exchange.budget + turns }, now))
    return [...drafts, ...release(sqlite, exchangeId, now, { check: true })]
  }
  if (decision?.action === 'stop_exchange')
    return stopExchanges(sqlite, [exchangeId], `${lead} stopped it`, now).drafts
  // No decision: the pause goes back to the person, and the lead isn't offered again.
  return updateExchange(sqlite, exchangeId, { decider_turn_id: null, lead_extended: 1 }, now)
}
