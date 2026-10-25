import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { readAgentNames } from './agents.ts'
import { roomChanged } from './rooms.ts'

// The always-on team room of the new shell (PLAN 11.1b, docs/briefs/11.0-bold.md §3.1): every agent is a member, jobs
// are its threads, agents route work with exchange actions. Its lead stays unset until the person picks one (first
// run, 11.10b); Score never guesses which agent leads. The classic shell leaves the room out.

export const TEAM_ROOM_NAME = 'Team room'

export function teamRoomId(sqlite: DatabaseSync): string | null {
  const row = sqlite.prepare("SELECT id FROM rooms WHERE role = 'team'").get() as
    { id: string } | undefined
  return row?.id ?? null
}

/** A free room name: "Team room", else "Team room 2", … (names are unique, and the person may own one already). */
function freeName(sqlite: DatabaseSync): string {
  const taken = (name: string) =>
    Boolean(sqlite.prepare('SELECT 1 FROM rooms WHERE name = ?').get(name))
  if (!taken(TEAM_ROOM_NAME)) return TEAM_ROOM_NAME
  let n = 2
  while (taken(`${TEAM_ROOM_NAME} ${n}`)) n++
  return `${TEAM_ROOM_NAME} ${n}`
}

/**
 * Creates the team room once, and keeps its members equal to the team's agents (sorted). Called at startup with the
 * agents the adapter lists; an empty list (Hermes not reachable yet) changes nothing.
 */
export function ensureTeamRoom(
  sqlite: DatabaseSync,
  agentIds: readonly string[],
  now: string,
): DomainEventDraft[] {
  if (agentIds.length === 0) return []
  const members = JSON.stringify([...new Set(agentIds)].sort())
  const id = teamRoomId(sqlite)
  if (id === null) {
    const roomId = randomUUID()
    sqlite
      .prepare(
        `INSERT INTO rooms (id, name, kind, lead_agent_id, members, created_at, updated_at, role, routing)
         VALUES (?, ?, 'room', NULL, ?, ?, ?, 'team', 'exchanges')`,
      )
      .run(roomId, freeName(sqlite), members, now, now)
    return roomChanged(sqlite, roomId, now)
  }
  const current = z
    .object({ members: z.string() })
    .parse(sqlite.prepare('SELECT members FROM rooms WHERE id = ?').get(id))
  if (current.members === members) return []
  sqlite
    .prepare('UPDATE rooms SET members = ?, updated_at = ?, version = version + 1 WHERE id = ?')
    .run(members, now, id)
  return roomChanged(sqlite, id, now)
}

/**
 * Keeps the team room's members current after an agent was added, removed or renamed: the existing members plus every
 * projected agent (Hermes profiles and coding agents), minus agents the projection says are removed or deleting. The
 * existing members stay so a partial projection (one agent reconciled before the rest) never shrinks the room.
 * Does nothing before the room exists (startup makes it).
 */
export function syncTeamRoomMembers(
  sqlite: DatabaseSync,
  now: string,
  removed: readonly string[] = [],
): DomainEventDraft[] {
  const id = teamRoomId(sqlite)
  if (id === null) return []
  const current = z
    .object({ members: z.string() })
    .parse(sqlite.prepare('SELECT members FROM rooms WHERE id = ?').get(id))
  const gone = removed.slice()
  gone.push(
    ...sqlite
      .prepare(
        `SELECT id FROM agents_proj
       WHERE COALESCE(json_extract(detail, '$.lifecycle.state'), 'ready') IN ('removed', 'deleting')`,
      )
      .all()
      .map((row) => z.object({ id: z.string() }).parse(row).id),
  )
  const ids = [
    ...z.array(z.string()).parse(JSON.parse(current.members)),
    ...readAgentNames(sqlite).map((agent) => agent.id),
  ].filter((agent) => !gone.includes(agent))
  return ensureTeamRoom(sqlite, ids, now)
}
