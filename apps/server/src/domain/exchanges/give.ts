import type { DatabaseSync } from 'node:sqlite'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { agentAdmits } from '../agent-lifecycle.ts'
import type { MessageRun } from '../message-runs.ts'
import { reserveMessageRun } from '../message-runs.ts'
import { hold, jobLimitFor, limitFor, type HeldTurn } from './budget.ts'
import { exchangeRow } from './store.ts'

/**
 * Queues a turn of a job, or holds it on its exchange when the exchange may not go on (a limit, an agent that can't take
 * work). Returns whether it was queued.
 */
/**
 * `holdOn`: the exchange to hold the turn on when it belongs to none (an answer back to a turn the person started is
 * held on the question it answers).
 */
export type Give = ((
  agentId: string,
  input: string,
  exchangeId: string | null,
  holdOn?: string,
) => boolean) & {
  /** The turn as it would be held instead. */
  held: (agentId: string, input: string, exchangeId: string | null) => Omit<HeldTurn, 'resume'>
}

export function makeGive(
  sqlite: DatabaseSync,
  from: Pick<MessageRun, 'room_id' | 'chain_id' | 'agents'> & {
    agentId: string | null
    messageId: string
    jobId: string
  },
  drafts: DomainEventDraft[],
  now: string,
): Give {
  const heldOf = (agentId: string, input: string, exchangeId: string | null) => ({
    agentId,
    input,
    parentMessageId: from.messageId,
    chainId: from.chain_id,
    fromAgentId: from.agentId,
    roomId: from.room_id,
    agents: from.agents,
    exchangeId,
  })
  const give = (agentId: string, input: string, exchangeId: string | null, holdOn?: string) => {
    const held = heldOf(agentId, input, exchangeId)
    const exchange = exchangeId ? exchangeRow(sqlite, exchangeId) : null
    const open = exchange !== null && !['done', 'stopped'].includes(exchange.state)
    const target = exchangeId ?? holdOn ?? null
    if (!agentAdmits(sqlite, agentId)) {
      if (target)
        drafts.push(
          ...hold(sqlite, target, 'unreachable', held, now, `${agentId} can't take work right now`),
        )
      return false
    }
    // An exchange still going passes its own budget and the job's limits; any other agent-started turn (an approval's
    // last word, an answer back) passes the job's.
    const limit = open ? limitFor(sqlite, exchange.id) : jobLimitFor(sqlite, from.jobId)
    if (limit && target) {
      drafts.push(...hold(sqlite, target, limit, held, now))
      return false
    }
    reserveMessageRun(
      sqlite,
      {
        parentMessageId: from.messageId,
        roomId: from.room_id,
        agentId,
        chainId: from.chain_id,
        // hop counts @mention hand-offs (D3.2, at most 4); exchanges are bounded by turn budgets instead (§4.5), so
        // a turn an agent starts here is simply "not the person's" (hop > 0).
        hop: 1,
        input,
        agents: from.agents,
        ...(from.agentId ? { fromAgentId: from.agentId } : {}),
        exchangeId,
        // One completion can give the same agent two turns (an answer back and a hand-off): one per exchange.
        retryNonce: exchangeId ?? 'job',
      },
      now,
    )
    return true
  }
  return Object.assign(give, { held: heldOf })
}
