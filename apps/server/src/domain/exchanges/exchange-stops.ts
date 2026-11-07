import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { roomMembers } from './actions.ts'
import { hold } from './budget.ts'
import { exchangeRow, latestMessage, updateExchange } from './store.ts'

/**
 * Stops exchanges and their open children: queued turns end, running ones are marked stopped (their actions are
 * dropped when they complete) and returned for the caller to stop through the port; a lead's deciding turn goes too.
 * An exchange that was waiting on the answer to a stopped question is handed to the person.
 */
export function stopExchanges(
  sqlite: DatabaseSync,
  ids: string[],
  reason: string,
  now: string,
): { drafts: DomainEventDraft[]; running: { agentId: string; runId: string }[] } {
  const drafts: DomainEventDraft[] = []
  const running: { agentId: string; runId: string }[] = []
  const stopping = new Set<string>()
  const queue = [...ids]
  for (let id = queue.shift(); id; id = queue.shift()) {
    const exchange = exchangeRow(sqlite, id)
    if (!exchange || stopping.has(id)) continue
    stopping.add(id)
    for (const child of sqlite
      .prepare("SELECT id FROM exchanges WHERE parent_id = ? AND state NOT IN ('done', 'stopped')")
      .all(id) as { id: string }[])
      queue.push(child.id)
    if (['done', 'stopped'].includes(exchange.state)) continue
    const turns = z
      .array(TurnToStopSchema)
      .parse(
        sqlite
          .prepare(
            "SELECT turn_id, state, run_id, agent_id FROM message_runs WHERE (exchange_id = ? OR turn_id = ?) AND state IN ('pending', 'active')",
          )
          .all(id, exchange.decider_turn_id ?? ''),
      )
    running.push(...stopTurns(sqlite, turns, now))
    drafts.push(
      ...updateExchange(
        sqlite,
        id,
        {
          state: 'stopped',
          ended_reason: reason,
          pause_reason: null,
          held: null,
          decider_turn_id: null,
        },
        now,
      ),
    )
  }
  // A question stopped under an exchange that waited on its answer: the asker goes on without it, or the person stops it.
  for (const id of stopping) {
    const child = exchangeRow(sqlite, id)!
    const parent = child.parent_id ? exchangeRow(sqlite, child.parent_id) : null
    if (
      child.kind !== 'ask' ||
      !parent ||
      stopping.has(parent.id) ||
      parent.state !== 'waiting_on_agent' ||
      parent.to_agent_id !== child.from_agent_id
    )
      continue
    const message = latestMessage(sqlite, parent.job_id)
    sqlite.prepare("UPDATE exchanges SET state = 'live' WHERE id = ?").run(parent.id)
    drafts.push(
      ...hold(
        sqlite,
        parent.id,
        'question_stopped',
        {
          agentId: child.from_agent_id,
          input: `Your question to ${child.to_agent_id} was stopped. Go on without the answer.`,
          parentMessageId: message,
          chainId: message,
          fromAgentId: null,
          roomId: parent.room_id,
          agents: roomMembers(sqlite, parent.room_id),
          exchangeId: parent.id,
        },
        now,
        `the question to ${child.to_agent_id} was stopped`,
      ),
    )
  }
  return { drafts, running }
}

export const TurnToStopSchema = z.object({
  turn_id: z.string(),
  state: z.string(),
  run_id: z.string().nullable(),
  agent_id: z.string(),
})
type TurnToStop = z.infer<typeof TurnToStopSchema>

/** Ends queued turns and marks running ones stopped; returns the running ones for the port to stop. */
export function stopTurns(
  sqlite: DatabaseSync,
  turns: TurnToStop[],
  now: string,
): { agentId: string; runId: string }[] {
  const running: { agentId: string; runId: string }[] = []
  for (const turn of turns) {
    if (turn.state === 'active') {
      sqlite
        .prepare('UPDATE message_runs SET stop_requested_at = ? WHERE turn_id = ?')
        .run(now, turn.turn_id)
      if (turn.run_id) running.push({ agentId: turn.agent_id, runId: turn.run_id })
    } else
      sqlite
        .prepare("UPDATE message_runs SET state = 'failed' WHERE turn_id = ? AND state = 'pending'")
        .run(turn.turn_id)
  }
  return running
}
