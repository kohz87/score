import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DeriveEvents, DomainEventDraft } from '../hub/ingest.ts'
import { activityIndex, busyAgents, membersOf, type ActivityIndex } from './rooms-activity.ts'
import { readRoom } from './rooms-read.ts'
import { rememberBusy } from './rooms-write.ts'
import { RoomRowSchema, type RoomRow } from './rooms-rows.ts'

/** Rooms of `candidates` (all rooms when omitted) whose busy set differs from the last one sent. */
function changedRooms(
  sqlite: DatabaseSync,
  now: string,
  index: ActivityIndex,
  candidates?: (row: RoomRow) => boolean,
): RoomRow[] {
  return z
    .array(RoomRowSchema)
    .parse(sqlite.prepare('SELECT * FROM rooms').all())
    .filter(
      (row) =>
        (candidates?.(row) ?? true) && JSON.stringify(busyAgents(row, index)) !== row.active_agents,
    )
}

function resend(
  sqlite: DatabaseSync,
  now: string,
  index: ActivityIndex,
  rows: RoomRow[],
): DomainEventDraft[] {
  return rows.map((row) => {
    const room = readRoom(sqlite, row.id, now, index)
    // `updated_at` marks the last state sent.
    sqlite
      .prepare('UPDATE rooms SET updated_at = ?, version = version + 1 WHERE id = ?')
      .run(now, row.id)
    rememberBusy(sqlite, row.id, room.activeAgents)
    return { type: 'room.upserted' as const, data: room }
  })
}

/**
 * Ingest hook (createIngest deriveEvents): an approval that opens or closes, or a reply that finishes, changes who is
 * busy, and nothing else tells the rooms list. Sends the state of the rooms whose busy set actually changed, in the
 * same transaction.
 */
export const deriveRoomEvents: DeriveEvents = (sqlite, drafts, { now }) => {
  const agents = new Set(
    drafts.flatMap((draft) =>
      draft.type === 'approval.requested' || draft.type === 'approval.updated'
        ? [draft.data.agentId]
        : [],
    ),
  )
  // A streaming reply that finished or was deleted frees its author.
  const finished = new Set<string>()
  for (const draft of drafts)
    if (draft.type === 'message.completed' || draft.type === 'message.deleted')
      finished.add(draft.data.roomId)
  if (agents.size === 0 && finished.size === 0) return []
  const index = activityIndex(sqlite, now)
  return resend(
    sqlite,
    now,
    index,
    changedRooms(
      sqlite,
      now,
      index,
      (row) => finished.has(row.id) || membersOf(row).some((agent) => agents.has(agent)),
    ),
  )
}

/** Rooms whose busy set changed without an event (an approval ran out, the compatibility check changed). */
export function staleRoomIds(sqlite: DatabaseSync, now: string): string[] {
  return changedRooms(sqlite, now, activityIndex(sqlite, now)).map((row) => row.id)
}

export function refreshRooms(sqlite: DatabaseSync, now: string): DomainEventDraft[] {
  const index = activityIndex(sqlite, now)
  return resend(sqlite, now, index, changedRooms(sqlite, now, index))
}
