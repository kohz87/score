import type { DatabaseSync } from 'node:sqlite'
import type { Room } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { readRoom } from './rooms-read.ts'
import { RoomRowSchema } from './rooms-rows.ts'

/** A room name not yet taken: `base`, else `base (one to one)`, then numbered. Room names are unique (409 otherwise). */
export function freeRoomName(sqlite: DatabaseSync, base: string): string {
  const taken = (name: string) =>
    Boolean(sqlite.prepare('SELECT 1 FROM rooms WHERE name = ?').get(name))
  if (!taken(base)) return base
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? `${base} (one to one)` : `${base} (one to one ${n})`
    if (!taken(name)) return name
  }
  return `${base} (${Date.now().toString(36)})`
}

export function insertRoom(
  sqlite: DatabaseSync,
  room: Pick<Room, 'id' | 'name' | 'kind' | 'leadAgentId' | 'members'> & {
    /** Stored as given (agentId, sessionId, source, label); `continued` is derived from room_sessions. */
    importedFrom?: { agentId: string; sessionId: string; source: string; label: string }
    /** Rooms people talk in route with exchanges (11.11); an orchestration or workflow run's room keeps mentions. */
    routing?: Room['routing']
    /** 3.4.0: a team room of chosen agents (decision 136); the everyone team room is made by ensureTeamRoom. */
    role?: 'team'
  },
  now: string,
): void {
  if (sqlite.prepare('SELECT id FROM rooms WHERE name = ?').get(room.name))
    throw new HttpError(409, 'conflict', 'A room with that name already exists.')
  sqlite
    .prepare(
      `INSERT INTO rooms (id, name, kind, lead_agent_id, members, created_at, updated_at, imported_from, routing, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      room.id,
      room.name,
      room.kind,
      room.leadAgentId,
      JSON.stringify(room.members),
      now,
      now,
      room.importedFrom ? JSON.stringify(room.importedFrom) : null,
      room.routing ?? 'exchanges',
      room.role ?? (room.kind === 'direct' ? 'direct' : 'room'),
    )
}

/**
 * An agent that is gone: out of every room's members, no longer any room's lead, and its pending turns failed. The
 * Hermes retire path and the team room's membership sync share this.
 */
export function retireAgentFromRooms(
  sqlite: DatabaseSync,
  agentId: string,
  now: string,
): DomainEventDraft[] {
  const events: DomainEventDraft[] = []
  const rooms = z.array(RoomRowSchema).parse(sqlite.prepare('SELECT * FROM rooms').all())
  for (const room of rooms) {
    const all = z.array(z.string()).parse(JSON.parse(room.members))
    const members = all.filter((id) => id !== agentId)
    if (room.lead_agent_id !== agentId && members.length === all.length) continue
    sqlite
      .prepare(
        'UPDATE rooms SET members = ?, lead_agent_id = CASE WHEN lead_agent_id = ? THEN NULL ELSE lead_agent_id END, updated_at = ?, version = version + 1 WHERE id = ?',
      )
      .run(JSON.stringify(members), agentId, now, room.id)
    events.push(...roomChanged(sqlite, room.id, now))
  }
  sqlite
    .prepare("UPDATE message_runs SET state = 'failed' WHERE agent_id = ? AND state = 'pending'")
    .run(agentId)
  return events
}

export function roomChanged(
  sqlite: DatabaseSync,
  id: string,
  now: string,
  before?: Room,
): DomainEventDraft[] {
  const after = readRoom(sqlite, id, now)
  if (before && JSON.stringify(before) === JSON.stringify(after)) return []
  if (before)
    sqlite
      .prepare('UPDATE rooms SET updated_at = ?, version = version + 1 WHERE id = ?')
      .run(now, id)
  rememberBusy(sqlite, id, after.activeAgents)
  return [{ type: 'room.upserted', data: after }]
}

/** The busy set last sent for a room: room updates go out only when the set differs from it. */
export function rememberBusy(sqlite: DatabaseSync, id: string, busy: string[]): void {
  sqlite.prepare('UPDATE rooms SET active_agents = ? WHERE id = ?').run(JSON.stringify(busy), id)
}
