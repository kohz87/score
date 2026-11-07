import type { DatabaseSync } from 'node:sqlite'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { settleExchangeTurn } from './exchanges/apply.ts'
import { exchangeRoom } from './message-runs-complete.ts'
import { MessageRunSchema } from './message-runs-turns.ts'
import { storeMessage } from './rooms.ts'

export function failMessageRun(
  sqlite: DatabaseSync,
  turnId: string,
  code: string,
  now: string,
  notice?: string,
): DomainEventDraft[] {
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE turn_id = ?').get(turnId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  if (mapping.state !== 'pending') return []
  sqlite.prepare("UPDATE message_runs SET state = 'failed' WHERE turn_id = ?").run(turnId)
  // A turn that never started still ends its part in an exchange: whoever waited on it now waits on the person.
  const settled = exchangeRoom(sqlite, mapping)
    ? settleExchangeTurn(
        sqlite,
        mapping,
        mapping.message_id,
        { status: 'failed', reply: '', coding: false },
        now,
      )
    : { drafts: [], notices: [] }
  // The contract has no system part; a short text notice from the agent explains the silence.
  const stored = storeMessage(
    sqlite,
    {
      id: mapping.message_id,
      roomId: mapping.room_id,
      author: { kind: 'agent', agentId: mapping.agent_id },
      to: [],
      parts: [
        { kind: 'text', text: notice ?? `Couldn't start this agent (${code}).` },
        ...settled.notices,
      ],
      createdAt: now,
      streaming: false,
      refs: [],
      ...(mapping.job_id ? { jobId: mapping.job_id } : {}),
      ...(mapping.alternative_of ? { alternativeOf: mapping.alternative_of } : {}),
    },
    now,
  )
  return [...settled.drafts, ...stored]
}
