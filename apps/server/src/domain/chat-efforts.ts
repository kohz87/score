import type { DatabaseSync } from 'node:sqlite'
import { CODING_EFFORTS, HERMES_CHAT_EFFORTS, type CodingRuntime } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'

// An agent's effort in one chat (decision 178). It wins over the agent's own setting in that chat and nowhere else.

const RowSchema = z.object({ room_id: z.string(), agent_id: z.string(), effort: z.string() })

/** A Hermes agent: what Hermes takes and Score offers. A coding agent: what its CLI takes. */
export function effortLevelsOf(sqlite: DatabaseSync, agentId: string): readonly string[] {
  const coding = sqlite.prepare('SELECT runtime FROM coding_agents WHERE id = ?').get(agentId) as
    { runtime: CodingRuntime } | undefined
  return coding ? (CODING_EFFORTS[coding.runtime] ?? []) : HERMES_CHAT_EFFORTS
}

const changed = (
  roomId: string,
  agentId: string,
  effort: string | null,
  reason: 'person' | 'model',
): DomainEventDraft => ({ type: 'effort.changed', data: { roomId, agentId, effort, reason } })

export function setChatEffort(
  sqlite: DatabaseSync,
  roomId: string,
  agentId: string,
  effort: string | null,
  now: string,
): DomainEventDraft[] {
  if (effort === null)
    sqlite
      .prepare('DELETE FROM chat_efforts WHERE room_id = ? AND agent_id = ?')
      .run(roomId, agentId)
  else
    sqlite
      .prepare(
        `INSERT INTO chat_efforts (room_id, agent_id, effort, set_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (room_id, agent_id) DO UPDATE SET effort = excluded.effort, set_at = excluded.set_at`,
      )
      .run(roomId, agentId, effort, now)
  return [changed(roomId, agentId, effort, 'person')]
}

export function chatEffortsOfRoom(
  sqlite: DatabaseSync,
  roomId: string,
): { roomId: string; agentId: string; effort: string }[] {
  return z
    .array(RowSchema)
    .parse(
      sqlite
        .prepare(
          'SELECT room_id, agent_id, effort FROM chat_efforts WHERE room_id = ? ORDER BY agent_id',
        )
        .all(roomId),
    )
    .map((row) => ({ roomId: row.room_id, agentId: row.agent_id, effort: row.effort }))
}

export function chatEffortsOfAgent(
  sqlite: DatabaseSync,
  agentId: string,
): {
  roomId: string
  roomName: string
  roomKind: 'group' | 'direct'
  jobTitle: string | null
  effort: string
}[] {
  return (
    sqlite
      .prepare(
        `SELECT e.room_id, r.name, r.role, e.effort,
           (SELECT title FROM jobs j WHERE j.room_id = e.room_id AND j.is_default = 0 AND j.state != 'closed'
              AND j.deleted_at IS NULL ORDER BY j.updated_at DESC LIMIT 1) AS job_title
         FROM chat_efforts e JOIN rooms r ON r.id = e.room_id
         WHERE e.agent_id = ? ORDER BY r.name`,
      )
      .all(agentId) as {
      room_id: string
      name: string
      role: string
      effort: string
      job_title: string | null
    }[]
  ).map((row) => ({
    roomId: row.room_id,
    roomName: row.name,
    roomKind: row.role === 'direct' ? ('direct' as const) : ('group' as const),
    jobTitle: row.job_title,
    effort: row.effort,
  }))
}

/**
 * The effort a turn runs at in this chat, recorded on the turn for its reply's label. A level the agent no longer takes
 * (it moved to another program) goes back to its own, and the room is told why.
 */
export function effortForTurn(
  sqlite: DatabaseSync,
  turn: { roomId: string; agentId: string; turnId: string },
): { effort: string | null; drafts: DomainEventDraft[] } {
  const row = sqlite
    .prepare('SELECT effort FROM chat_efforts WHERE room_id = ? AND agent_id = ?')
    .get(turn.roomId, turn.agentId) as { effort: string } | undefined
  if (!row) return { effort: null, drafts: [] }
  if (!effortLevelsOf(sqlite, turn.agentId).includes(row.effort)) {
    sqlite
      .prepare('DELETE FROM chat_efforts WHERE room_id = ? AND agent_id = ?')
      .run(turn.roomId, turn.agentId)
    return { effort: null, drafts: [changed(turn.roomId, turn.agentId, null, 'model')] }
  }
  sqlite
    .prepare('UPDATE message_runs SET effort = ? WHERE turn_id = ?')
    .run(row.effort, turn.turnId)
  sqlite
    .prepare(
      'UPDATE messages SET effort = ? WHERE id = (SELECT message_id FROM message_runs WHERE turn_id = ?)',
    )
    .run(row.effort, turn.turnId)
  return { effort: row.effort, drafts: [] }
}
