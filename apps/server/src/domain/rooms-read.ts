import type { DatabaseSync } from 'node:sqlite'
import { RoomSchema, type Room } from '@score/contract'
import { z } from 'zod'
import { autoSummaryOf } from './room-summaries.ts'
import { activityIndex, busyAgents, membersOf, type ActivityIndex } from './rooms-activity.ts'
import { importedFrom, nameTags, roomRow } from './rooms-rows.ts'

const CountSchema = z.object({ count: z.int().nonnegative() })

export function readRoom(
  sqlite: DatabaseSync,
  id: string,
  now: string,
  index?: ActivityIndex,
): Room {
  const row = roomRow(sqlite, id)
  const unread = CountSchema.parse(
    sqlite
      .prepare(
        `
    SELECT count(*) AS count FROM messages m
      JOIN jobs j ON j.id = m.job_id AND j.is_default = 1
      LEFT JOIN job_reads r ON r.job_id = m.job_id
    WHERE m.room_id = ? AND m.author_kind = 'agent' AND m.deleted_at IS NULL AND
      (r.job_id IS NULL OR (m.created_at, m.id) > (r.last_read_message_created_at, r.last_read_message_id))
  `,
      )
      .get(id),
  ).count
  const activeAgents = busyAgents(
    row,
    index ?? activityIndex(sqlite, now, { roomId: id, agents: membersOf(row) }),
  )
  return RoomSchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    leadAgentId: row.lead_agent_id,
    members: JSON.parse(row.members) as unknown,
    unread,
    activeAgents,
    channels: [],
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    tags: row.tags === null ? nameTags(row.name) : z.array(z.string()).parse(JSON.parse(row.tags)),
    importedFrom: importedFrom(sqlite, row),
    autoSummary: autoSummaryOf(row.auto_summary),
    role: row.role,
    routing: row.routing,
    ...(row.role === 'team' ? { everyone: row.team_everyone === 1 } : {}),
  })
}

/** Every room's state with one activity read for all of them. */
export function readAllRooms(sqlite: DatabaseSync, now: string): Room[] {
  const index = activityIndex(sqlite, now)
  return roomIds(sqlite).map((id) => readRoom(sqlite, id, now, index))
}

export function roomIds(sqlite: DatabaseSync): string[] {
  return (
    z
      .array(z.object({ id: z.string() }))
      // The team room belongs to the new shell (PLAN 11.1b) and is read on its own.
      .parse(sqlite.prepare("SELECT id FROM rooms WHERE role != 'team' ORDER BY name, id").all())
      .map((row) => row.id)
  )
}
