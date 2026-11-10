import type { DatabaseSync } from 'node:sqlite'
import type { ChatModel } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { isMember } from './chat-efforts.ts'

// An agent's model in one chat (decision 182). It wins over the agent's own model in that chat and nowhere else: the
// agent's config, its other chats and its repeating jobs are untouched.

const RowSchema = z.object({
  room_id: z.string(),
  agent_id: z.string(),
  model: z.string(),
  provider: z.string().nullable(),
  label: z.string(),
})

const toChatModel = (row: z.infer<typeof RowSchema>): ChatModel => ({
  roomId: row.room_id,
  agentId: row.agent_id,
  model: row.model,
  provider: row.provider,
  label: row.label,
})

const changed = (
  roomId: string,
  agentId: string,
  chosen: { model: string; label: string } | null,
  reason: 'person' | 'member',
): DomainEventDraft => ({
  type: 'model.changed',
  data: { roomId, agentId, model: chosen?.model ?? null, label: chosen?.label ?? null, reason },
})

export function chatModelOf(
  sqlite: DatabaseSync,
  roomId: string,
  agentId: string,
): ChatModel | null {
  const row = sqlite
    .prepare(
      'SELECT room_id, agent_id, model, provider, label FROM chat_models WHERE room_id = ? AND agent_id = ?',
    )
    .get(roomId, agentId)
  return row ? toChatModel(RowSchema.parse(row)) : null
}

/** Sets (or, with null, clears) the agent's model in this chat. `replaced` is read in the same write, for Undo. */
export function setChatModel(
  sqlite: DatabaseSync,
  roomId: string,
  agentId: string,
  chosen: { model: string; provider: string | null; label: string } | null,
  now: string,
): { replaced: ChatModel | null; drafts: DomainEventDraft[] } {
  const replaced = chatModelOf(sqlite, roomId, agentId)
  if (chosen === null)
    sqlite
      .prepare('DELETE FROM chat_models WHERE room_id = ? AND agent_id = ?')
      .run(roomId, agentId)
  else
    sqlite
      .prepare(
        `INSERT INTO chat_models (room_id, agent_id, model, provider, label, set_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (room_id, agent_id) DO UPDATE SET model = excluded.model, provider = excluded.provider,
           label = excluded.label, set_at = excluded.set_at`,
      )
      .run(roomId, agentId, chosen.model, chosen.provider, chosen.label, now)
  return { replaced, drafts: [changed(roomId, agentId, chosen, 'person')] }
}

export function chatModelsOfRoom(sqlite: DatabaseSync, roomId: string): ChatModel[] {
  return z
    .array(RowSchema)
    .parse(
      sqlite
        .prepare(
          'SELECT room_id, agent_id, model, provider, label FROM chat_models WHERE room_id = ? ORDER BY agent_id',
        )
        .all(roomId),
    )
    .map(toChatModel)
}

export function chatModelsOfAgent(
  sqlite: DatabaseSync,
  agentId: string,
): {
  roomId: string
  roomName: string
  roomKind: 'group' | 'direct'
  jobTitle: string | null
  model: string
  label: string
}[] {
  return (
    sqlite
      .prepare(
        `SELECT m.room_id, r.name, r.role, m.model, m.label,
           (SELECT title FROM jobs j WHERE j.room_id = m.room_id AND j.is_default = 0 AND j.state != 'closed'
              AND j.deleted_at IS NULL ORDER BY j.updated_at DESC LIMIT 1) AS job_title
         FROM chat_models m JOIN rooms r ON r.id = m.room_id
         WHERE m.agent_id = ? ORDER BY r.name`,
      )
      .all(agentId) as {
      room_id: string
      name: string
      role: string
      model: string
      label: string
      job_title: string | null
    }[]
  ).map((row) => ({
    roomId: row.room_id,
    roomName: row.name,
    roomKind: row.role === 'direct' ? ('direct' as const) : ('group' as const),
    jobTitle: row.job_title,
    model: row.model,
    label: row.label,
  }))
}

/**
 * The model a turn runs on in this chat, recorded on the turn (`message_runs.model`/`provider`) so a retry or restart
 * sends it the same way and its reply is labelled. A turn that already names a model (Try another, or one recorded
 * before) keeps it. An agent taken out of the chat goes back to its own, and the room is told why.
 */
export function modelForTurn(
  sqlite: DatabaseSync,
  turn: { roomId: string; agentId: string; turnId: string },
): { drafts: DomainEventDraft[] } {
  const run = sqlite
    .prepare('SELECT model, model_chosen FROM message_runs WHERE turn_id = ?')
    .get(turn.turnId) as { model: string | null; model_chosen: number } | undefined
  if (!run || run.model || run.model_chosen) return { drafts: [] }
  // Decided now, whatever the outcome: a retry of this turn copies the decision.
  sqlite.prepare('UPDATE message_runs SET model_chosen = 1 WHERE turn_id = ?').run(turn.turnId)
  const chosen = chatModelOf(sqlite, turn.roomId, turn.agentId)
  if (!chosen) return { drafts: [] }
  if (!isMember(sqlite, turn.roomId, turn.agentId)) {
    sqlite
      .prepare('DELETE FROM chat_models WHERE room_id = ? AND agent_id = ?')
      .run(turn.roomId, turn.agentId)
    return { drafts: [changed(turn.roomId, turn.agentId, null, 'member')] }
  }
  sqlite
    .prepare('UPDATE message_runs SET model = ?, provider = ? WHERE turn_id = ?')
    .run(chosen.model, chosen.provider, turn.turnId)
  sqlite
    .prepare(
      'UPDATE messages SET model = ? WHERE id = (SELECT message_id FROM message_runs WHERE turn_id = ?)',
    )
    .run(chosen.model, turn.turnId)
  return { drafts: [] }
}
