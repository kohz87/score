import type { DatabaseSync } from 'node:sqlite'
import { EXCHANGE_LIMITS, type ExchangePauseReason } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { agentAdmits } from '../agent-lifecycle.ts'
import { reserveMessageRun } from '../message-runs.ts'
import { exchangeRow, jobRow, updateExchange, updateJob } from './store.ts'

// Budgets and held turns (docs/briefs/11.1c-budgets.md). Before a job's agent-started turn is queued, its exchange's
// budget, the job's turn limit and the job's spend cap are checked; a turn that may not be queued is held on an exchange
// with the reason, and the person decides. Turns the person starts never count.

export const HeldTurnSchema = z.object({
  agentId: z.string(),
  input: z.string(),
  parentMessageId: z.string(),
  chainId: z.string(),
  fromAgentId: z.string().nullable(),
  roomId: z.string(),
  agents: z.array(z.string()),
  /** The exchange the turn belongs to (null: an answer back to a turn the person started). */
  exchangeId: z.string().nullable(),
  /** The state the holding exchange goes back to when the turn is released. */
  resume: z.enum(['live', 'waiting_on_agent', 'done']),
})
export type HeldTurn = z.infer<typeof HeldTurnSchema>

const count = (sqlite: DatabaseSync, sql: string, ...args: (string | number)[]) =>
  (sqlite.prepare(sql).get(...args) as { n: number }).n

/** The limit an exchange's next turn would cross (its own budget, then the job's), or null. */
export function limitFor(sqlite: DatabaseSync, exchangeId: string): ExchangePauseReason | null {
  const exchange = exchangeRow(sqlite, exchangeId)
  if (!exchange) return null
  // Started turns are counted at admission; queued ones count too, so two queued turns can't both slip under.
  const queued = count(
    sqlite,
    "SELECT count(*) AS n FROM message_runs WHERE exchange_id = ? AND state = 'pending'",
    exchangeId,
  )
  if (exchange.turns_used + queued >= exchange.budget) return 'exchange_budget'
  return jobLimitFor(sqlite, exchange.job_id)
}

/**
 * The job-wide limit a further agent-started turn would cross: the job's turn limit, or its spend cap. Every turn an
 * agent started counts (hop > 0), in an exchange or not (an answer back to a person-started turn).
 */
export function jobLimitFor(sqlite: DatabaseSync, jobId: string): ExchangePauseReason | null {
  const job = jobRow(sqlite, jobId)
  if (!job) return null
  const jobTurns = count(
    sqlite,
    `SELECT count(*) AS n FROM message_runs WHERE job_id = ? AND hop > 0 AND purpose IS NULL
       AND (state IN ('pending', 'active', 'completed') OR run_id IS NOT NULL)`,
    job.id,
  )
  if (jobTurns >= job.job_turn_limit) return 'job_limit'
  const cap = sqlite
    .prepare('SELECT spend_cap_usd, cost_unknown_accepted_at FROM jobs WHERE id = ?')
    .get(job.id) as { spend_cap_usd: number | null; cost_unknown_accepted_at: string | null }
  if (cap.spend_cap_usd === null) return null
  const runs = `FROM message_runs mr JOIN runs r ON r.id = mr.run_id WHERE mr.job_id = ?`
  const unknown = count(
    sqlite,
    `SELECT count(*) AS n ${runs} AND r.status != 'running' AND (r.cost_usd IS NULL OR r.cost_kind = 'unknown')
       AND COALESCE(r.ended_at, r.started_at) > ?`,
    job.id,
    cap.cost_unknown_accepted_at ?? '',
  )
  if (unknown > 0) return 'cost_unknown'
  const settled = (
    sqlite.prepare(`SELECT COALESCE(SUM(r.cost_usd), 0) AS usd ${runs}`).get(job.id) as {
      usd: number
    }
  ).usd
  // Queued turns will run too: reserve for them as for the running ones, so parallel hand-offs can't all pass the cap.
  const running = count(
    sqlite,
    "SELECT count(*) AS n FROM message_runs WHERE job_id = ? AND state IN ('pending', 'active') AND purpose IS NULL",
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

/**
 * Holds a turn on an exchange and hands the exchange to the person. The held turn remembers which state the exchange
 * goes back to (the one it had before this pause, kept across a pause that follows another).
 */
export function hold(
  sqlite: DatabaseSync,
  exchangeId: string,
  reason: ExchangePauseReason,
  held: Omit<HeldTurn, 'resume'> | null,
  now: string,
  endedReason: string | null = null,
): DomainEventDraft[] {
  const exchange = exchangeRow(sqlite, exchangeId)
  if (!exchange) return []
  const earlier = heldTurn(sqlite, exchangeId)
  const resume: HeldTurn['resume'] =
    earlier?.resume ??
    (exchange.state === 'waiting_on_agent' || exchange.state === 'done' ? exchange.state : 'live')
  return [
    ...updateExchange(
      sqlite,
      exchangeId,
      {
        state: BUDGET_REASONS.includes(reason) ? 'paused_budget' : 'waiting_on_you',
        pause_reason: reason,
        held: held ? JSON.stringify({ ...held, resume }) : null,
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
 * exchange back to the state it had. `check`: after the person raised one limit, the others still apply; a turn that
 * crosses one is held again with that reason. A held agent that can't take work any more is held as `unreachable`.
 */
export function release(
  sqlite: DatabaseSync,
  exchangeId: string,
  now: string,
  change: { agentId?: string; append?: string; exchangeId?: string | null; check?: boolean } = {},
): DomainEventDraft[] {
  const exchange = exchangeRow(sqlite, exchangeId)
  const held = heldTurn(sqlite, exchangeId)
  if (!exchange || !held) throw new Error(`exchange ${exchangeId} holds no turn to release`)
  const agentId = change.agentId ?? held.agentId
  const turnExchange = change.exchangeId === undefined ? held.exchangeId : change.exchangeId
  const { resume, ...again } = held
  if (!agentAdmits(sqlite, agentId))
    return hold(
      sqlite,
      exchangeId,
      'unreachable',
      { ...again, agentId },
      now,
      `${agentId} can't take work right now`,
    )
  if (change.check) {
    // Checked as if the exchange were going again, against the exchange the turn belongs to (or the job).
    const limit = turnExchange
      ? limitFor(sqlite, turnExchange)
      : jobLimitFor(sqlite, exchange.job_id)
    if (limit) return hold(sqlite, exchangeId, limit, { ...again, agentId }, now)
  }
  const drafts = updateExchange(
    sqlite,
    exchangeId,
    { state: resume, pause_reason: null, held: null, ended_reason: null, decider_turn_id: null },
    now,
  )
  reserveMessageRun(
    sqlite,
    {
      parentMessageId: held.parentMessageId,
      roomId: held.roomId,
      agentId,
      chainId: held.chainId,
      hop: 1,
      input: change.append ? `${held.input}\n\n${change.append}` : held.input,
      agents: held.agents,
      ...(held.fromAgentId ? { fromAgentId: held.fromAgentId } : {}),
      exchangeId: turnExchange,
      // A released turn is a new turn for that message, whatever was held or tried before.
      retryNonce: `release:${now}:${exchangeId}`,
    },
    now,
  )
  drafts.push(...updateJob(sqlite, exchange.job_id, { state: 'working' }, now))
  return drafts
}
