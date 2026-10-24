import type { DatabaseSync } from 'node:sqlite'
import { EXCHANGE_LIMITS, type ExchangePauseReason } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { reserveMessageRun } from '../message-runs.ts'
import { exchangeRow, jobRow, updateExchange, updateJob } from './store.ts'

// Budgets and held turns (docs/briefs/11.1c-budgets.md). Before an exchange gets a turn, its own budget, the job's
// turn limit and the job's spend cap are checked; a turn that may not be queued is held on the exchange with the reason,
// and the person decides. Turns the person starts never count.

export const HeldTurnSchema = z.object({
  agentId: z.string(),
  input: z.string(),
  parentMessageId: z.string(),
  chainId: z.string(),
  fromAgentId: z.string().nullable(),
  roomId: z.string(),
  agents: z.array(z.string()),
})
export type HeldTurn = z.infer<typeof HeldTurnSchema>

const count = (sqlite: DatabaseSync, sql: string, ...args: (string | number)[]) =>
  (sqlite.prepare(sql).get(...args) as { n: number }).n

/** Which limit the next turn of this exchange would cross, or null when it may be queued. */
export function limitFor(sqlite: DatabaseSync, exchangeId: string): ExchangePauseReason | null {
  const exchange = exchangeRow(sqlite, exchangeId)
  const job = exchange ? jobRow(sqlite, exchange.job_id) : null
  if (!exchange || !job) return null
  // Started turns are counted at admission; queued ones count too, so two queued turns can't both slip under.
  const queued = count(
    sqlite,
    "SELECT count(*) AS n FROM message_runs WHERE exchange_id = ? AND state = 'pending'",
    exchangeId,
  )
  if (exchange.turns_used + queued >= exchange.budget) return 'exchange_budget'
  const jobTurns = count(
    sqlite,
    `SELECT count(*) AS n FROM message_runs WHERE job_id = ? AND exchange_id IS NOT NULL
       AND (state IN ('pending', 'active', 'completed') OR run_id IS NOT NULL)`,
    job.id,
  )
  if (jobTurns >= job.job_turn_limit) return 'job_limit'
  const cap = sqlite
    .prepare('SELECT spend_cap_usd, cost_unknown_accepted_at FROM jobs WHERE id = ?')
    .get(job.id) as {
    spend_cap_usd: number | null
    cost_unknown_accepted_at: string | null
  }
  if (cap.spend_cap_usd === null) return null
  const runs = `FROM message_runs mr JOIN runs r ON r.id = mr.run_id WHERE mr.job_id = ?`
  const unknown = count(
    sqlite,
    `SELECT count(*) AS n ${runs} AND r.status != 'running' AND (r.cost_usd IS NULL OR r.cost_kind = 'unknown')
       AND r.updated_at > ?`,
    job.id,
    cap.cost_unknown_accepted_at ?? '',
  )
  if (unknown > 0) return 'cost_unknown'
  const settled = (
    sqlite.prepare(`SELECT COALESCE(SUM(r.cost_usd), 0) AS usd ${runs}`).get(job.id) as {
      usd: number
    }
  ).usd
  const running = count(
    sqlite,
    "SELECT count(*) AS n FROM message_runs WHERE job_id = ? AND state = 'active'",
    job.id,
  )
  const reserved = (running + 1) * EXCHANGE_LIMITS.turnEstimateUsd
  return settled + reserved > cap.spend_cap_usd ? 'spend_cap' : null
}

const BUDGET_REASONS: ExchangePauseReason[] = [
  'exchange_budget',
  'job_limit',
  'spend_cap',
  'cost_unknown',
]

/** Holds the turn an exchange would get next and hands the exchange to the person. */
export function hold(
  sqlite: DatabaseSync,
  exchangeId: string,
  reason: ExchangePauseReason,
  held: HeldTurn | null,
  now: string,
  endedReason: string | null = null,
): DomainEventDraft[] {
  const exchange = exchangeRow(sqlite, exchangeId)
  if (!exchange) return []
  return [
    ...updateExchange(
      sqlite,
      exchangeId,
      {
        state: BUDGET_REASONS.includes(reason) ? 'paused_budget' : 'waiting_on_you',
        pause_reason: reason,
        held: held ? JSON.stringify(held) : null,
        ended_reason: endedReason,
      },
      now,
    ),
    ...updateJob(sqlite, exchange.job_id, { state: 'waiting_on_you' }, now),
  ]
}

export function heldTurn(sqlite: DatabaseSync, exchangeId: string): HeldTurn | null {
  const held = exchangeRow(sqlite, exchangeId)?.held
  return held ? HeldTurnSchema.parse(JSON.parse(held)) : null
}

/**
 * Queues the held turn (to `agentId` when the person reassigned it, with `append` added to its input) and sets the
 * exchange going again. No limit is checked: the person (or the lead they asked) just decided.
 */
export function release(
  sqlite: DatabaseSync,
  exchangeId: string,
  now: string,
  change: { agentId?: string; append?: string; exchangeId?: string | null } = {},
): DomainEventDraft[] {
  const exchange = exchangeRow(sqlite, exchangeId)
  const held = heldTurn(sqlite, exchangeId)
  if (!exchange) return []
  const drafts = updateExchange(
    sqlite,
    exchangeId,
    { state: 'live', pause_reason: null, held: null, ended_reason: null, decider_turn_id: null },
    now,
  )
  if (held) {
    reserveMessageRun(
      sqlite,
      {
        parentMessageId: held.parentMessageId,
        roomId: held.roomId,
        agentId: change.agentId ?? held.agentId,
        chainId: held.chainId,
        hop: 1,
        input: change.append ? `${held.input}\n\n${change.append}` : held.input,
        agents: held.agents,
        ...(held.fromAgentId ? { fromAgentId: held.fromAgentId } : {}),
        exchangeId: change.exchangeId === undefined ? exchangeId : change.exchangeId,
        // A released turn is a new turn for that message, whatever was held or tried before.
        retryNonce: `release:${now}:${exchangeId}`,
      },
      now,
    )
    drafts.push(...updateJob(sqlite, exchange.job_id, { state: 'working' }, now))
  }
  return drafts
}
