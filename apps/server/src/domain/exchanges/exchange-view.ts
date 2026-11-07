import type { DatabaseSync } from 'node:sqlite'
import {
  ExchangeSchema,
  type Exchange,
  type ExchangeOption,
  type ExchangePauseReason,
} from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { exchangeRow } from './row-reads.ts'
import type { ExchangeRow } from './row-schemas.ts'

/** What the person can do about a paused exchange (docs/briefs/11.1c-budgets.md). */
export function pauseOptions(sqlite: DatabaseSync, row: ExchangeRow): ExchangeOption[] {
  const lead = (
    sqlite
      .prepare('SELECT r.lead_agent_id FROM rooms r JOIN jobs j ON j.room_id = r.id WHERE j.id = ?')
      .get(row.job_id) as { lead_agent_id: string | null } | undefined
  )?.lead_agent_id
  const leadMayDecide =
    lead &&
    lead !== row.from_agent_id &&
    lead !== row.to_agent_id &&
    row.lead_extended === 0 &&
    row.decider_turn_id === null
  // Reassigning only makes sense for the turn of the agent the exchange was opened to (not its author's side).
  const heldAgent = row.held ? (JSON.parse(row.held) as { agentId?: string }).agentId : undefined
  const reassign: ExchangeOption[] = heldAgent === row.to_agent_id ? ['reassign'] : []
  const options: Record<ExchangePauseReason, ExchangeOption[]> = {
    exchange_budget: [
      'more_turns',
      ...(leadMayDecide ? ['lead_decides' as const] : []),
      'step_in',
      'stop',
    ],
    job_limit: [
      'more_turns',
      ...(leadMayDecide ? ['lead_decides' as const] : []),
      'step_in',
      'stop',
    ],
    spend_cap: ['more_spend', 'step_in', 'stop'],
    cost_unknown: ['continue', 'step_in', 'stop'],
    turn_failed: ['retry', ...reassign, 'stop'],
    unreachable: ['retry', ...reassign, 'stop'],
    asker_gone: ['retry', ...(lead ? ['answer_to_lead' as const] : []), 'stop'],
    no_decision: ['ask_again', 'send_back', 'close'],
    author_stalled: ['ask_again', 'close'],
    question_stopped: ['continue', 'stop'],
  }
  return row.pause_reason ? options[row.pause_reason] : []
}

/** The agent whose turn in another job of the room holds this exchange's queued turn back (§4.6 row 3), or null. */
function queuedBehind(sqlite: DatabaseSync, row: ExchangeRow): Exchange['queuedBehind'] {
  if (row.state !== 'live') return null
  const waiting = sqlite
    .prepare(
      `SELECT q.agent_id, q.created_at FROM message_runs q
       WHERE q.exchange_id = ? AND q.state = 'pending' AND EXISTS (
         SELECT 1 FROM message_runs busy WHERE busy.room_id = q.room_id AND busy.agent_id = q.agent_id
           AND busy.state = 'active' AND busy.job_id IS NOT q.job_id)
       ORDER BY q.created_at LIMIT 1`,
    )
    .get(row.id) as { agent_id: string; created_at: string } | undefined
  return waiting ? { agentId: waiting.agent_id, since: waiting.created_at } : null
}

export const exchangeFromRow = (sqlite: DatabaseSync, row: ExchangeRow): Exchange =>
  ExchangeSchema.parse({
    id: row.id,
    jobId: row.job_id,
    roomId: row.room_id,
    kind: row.kind,
    parentId: row.parent_id,
    from: row.from_agent_id,
    to: row.to_agent_id,
    state: row.state,
    round: row.round,
    turnsUsed: row.turns_used,
    budget: row.budget,
    outcome: row.outcome,
    endedReason: row.ended_reason,
    pause:
      row.pause_reason && ['paused_budget', 'waiting_on_you'].includes(row.state)
        ? {
            reason: row.pause_reason,
            options: pauseOptions(sqlite, row),
            ...droppedTurns(row.held),
          }
        : null,
    queuedBehind: queuedBehind(sqlite, row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

/** The agents whose turns were dropped behind the held turn (budget.ts `hold`), when there are any. */
function droppedTurns(held: string | null): { droppedAgents?: string[] } {
  if (!held) return {}
  const parsed = z.object({ dropped: z.array(z.string()).optional() }).safeParse(JSON.parse(held))
  const dropped = parsed.success ? (parsed.data.dropped ?? []) : []
  return dropped.length ? { droppedAgents: dropped } : {}
}

export const exchangeEvent = (sqlite: DatabaseSync, id: string): DomainEventDraft[] => {
  const row = exchangeRow(sqlite, id)
  return row ? [{ type: 'exchange.upserted', data: exchangeFromRow(sqlite, row) }] : []
}
