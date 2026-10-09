import { releaseMessageMedia } from './media-refs.ts'
import type { DatabaseSync } from 'node:sqlite'
import {
  AgentIdSchema,
  MessageSchema,
  RoomImportSchema,
  RoomSchema,
  RoomTagSchema,
  type Message,
  type Room,
} from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { markStaleSummaries } from './summary-stale.ts'
import { autoSummaryOf } from './room-summaries.ts'

export const RoomRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: RoomSchema.shape.kind,
  lead_agent_id: AgentIdSchema.nullable(),
  members: z.string(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  version: z.int().positive(),
  pinned: z.union([z.literal(0), z.literal(1)]),
  archived: z.union([z.literal(0), z.literal(1)]),
  project_id: z.string().nullable(),
  tags: z.string().nullable(),
  imported_from: z.string().nullable(),
  auto_summary: z.string().nullable(),
})
export const MessageRowSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  author_kind: z.enum(['you', 'agent']),
  author_agent_id: AgentIdSchema.nullable(),
  to: z.string(),
  parts: z.string(),
  refs: z.string(),
  streaming: z.union([z.literal(0), z.literal(1)]),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  version: z.int().positive(),
  edited_by: z.string().nullish(),
  edits: z.string().nullish(),
  deleted_at: z.string().nullish(),
  progress_at: z.string().nullish(),
})
const CountSchema = z.object({ count: z.int().nonnegative() })

/** `#tag` words after the first word of a room's name ("#launch #q4 #urgent"), lower-case and valid only. */
export function nameTags(name: string): string[] {
  const tags = name
    .split(/\s+/)
    .slice(1)
    .flatMap((word) => (word.startsWith('#') ? [word.slice(1).toLowerCase()] : []))
    .filter((tag) => RoomTagSchema.safeParse(tag).success)
  return [...new Set(tags)]
}

function importedFrom(
  sqlite: DatabaseSync,
  row: z.infer<typeof RoomRowSchema>,
): Room['importedFrom'] {
  if (row.imported_from === null) return null
  const base = z
    .object({
      agentId: AgentIdSchema,
      sessionId: z.string(),
      source: z.string(),
      label: z.string(),
    })
    .parse(JSON.parse(row.imported_from))
  const mode = sqlite
    .prepare('SELECT mode FROM room_sessions WHERE room_id = ? AND agent_id = ?')
    .get(row.id, base.agentId)
  return RoomImportSchema.parse({
    ...base,
    continued: z.object({ mode: z.string() }).nullish().parse(mode)?.mode ?? null,
  })
}

export function roomRow(sqlite: DatabaseSync, id: string) {
  const row = sqlite.prepare('SELECT * FROM rooms WHERE id = ?').get(id)
  if (!row) throw new HttpError(404, 'not_found', 'Unknown room')
  return RoomRowSchema.parse(row)
}

export function readRoom(sqlite: DatabaseSync, id: string, now: string): Room {
  const row = roomRow(sqlite, id)
  const unread = CountSchema.parse(
    sqlite
      .prepare(
        `
    SELECT count(*) AS count FROM messages m LEFT JOIN room_reads r ON r.room_id = m.room_id
    WHERE m.room_id = ? AND m.author_kind = 'agent' AND m.deleted_at IS NULL AND
      (r.room_id IS NULL OR (m.created_at, m.id) > (r.last_read_message_created_at, r.last_read_message_id))
  `,
      )
      .get(id),
  ).count
  const cutoff = new Date(Date.parse(now) - 10 * 60 * 1000).toISOString()
  const activeAgents = z
    .array(z.object({ author_agent_id: AgentIdSchema }))
    .parse(
      sqlite
        .prepare(
          `SELECT DISTINCT author_agent_id FROM messages
      WHERE room_id = ? AND author_kind = 'agent' AND deleted_at IS NULL AND created_at > ? ORDER BY author_agent_id`,
        )
        .all(id, cutoff),
    )
    .map((agent) => agent.author_agent_id)
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
    tags: row.tags === null ? nameTags(row.name) : z.array(z.string()).parse(JSON.parse(row.tags)),
    importedFrom: importedFrom(sqlite, row),
    autoSummary: autoSummaryOf(row.auto_summary),
  })
}

export function roomIds(sqlite: DatabaseSync): string[] {
  return z
    .array(z.object({ id: z.string() }))
    .parse(sqlite.prepare('SELECT id FROM rooms ORDER BY name, id').all())
    .map((row) => row.id)
}

export function insertRoom(
  sqlite: DatabaseSync,
  room: Pick<Room, 'id' | 'name' | 'kind' | 'leadAgentId' | 'members'> & {
    /** Stored as given (agentId, sessionId, source, label); `continued` is derived from room_sessions. */
    importedFrom?: { agentId: string; sessionId: string; source: string; label: string }
  },
  now: string,
): void {
  if (sqlite.prepare('SELECT id FROM rooms WHERE name = ?').get(room.name))
    throw new HttpError(409, 'conflict', 'Room name already exists')
  sqlite
    .prepare(
      `INSERT INTO rooms (id, name, kind, lead_agent_id, members, created_at, updated_at, imported_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
    )
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
  return [{ type: 'room.upserted', data: after }]
}

export function refreshRooms(sqlite: DatabaseSync, now: string): DomainEventDraft[] {
  // updated_at is the last emitted room state; compare activity windows without a second cache.
  return roomIds(sqlite).flatMap((id) =>
    roomChanged(sqlite, id, now, readRoom(sqlite, id, roomRow(sqlite, id).updated_at)),
  )
}

export function messageFromRow(value: unknown): Message {
  const row = MessageRowSchema.parse(value)
  return MessageSchema.parse({
    id: row.id,
    roomId: row.room_id,
    author:
      row.author_kind === 'you' ? { kind: 'you' } : { kind: 'agent', agentId: row.author_agent_id },
    to: JSON.parse(row.to) as unknown,
    parts: JSON.parse(row.parts) as unknown,
    refs: JSON.parse(row.refs) as unknown,
    createdAt: row.created_at,
    streaming: row.streaming === 1,
    ...(row.streaming === 1 && row.progress_at ? { progressAt: row.progress_at } : {}),
    ...(row.edited_by ? { editedBy: row.edited_by } : {}),
    ...(row.edits ? { edits: row.edits } : {}),
  })
}

export function storeMessage(
  sqlite: DatabaseSync,
  value: Message,
  now: string,
): DomainEventDraft[] {
  const message = MessageSchema.parse(value)
  const before = readRoom(sqlite, message.roomId, roomRow(sqlite, message.roomId).updated_at)
  const result = sqlite
    .prepare(
      `INSERT INTO messages
    (id, room_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at, edits, progress_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    )
    .run(
      message.id,
      message.roomId,
      message.author.kind,
      message.author.kind === 'agent' ? message.author.agentId : null,
      JSON.stringify(message.to),
      JSON.stringify(message.parts),
      JSON.stringify(message.refs),
      Number(message.streaming),
      message.createdAt,
      now,
      message.edits ?? null,
      message.streaming ? (message.progressAt ?? now) : null,
    )
  if (!result.changes) return []
  return [
    { type: 'message.created', data: message },
    ...roomChanged(sqlite, message.roomId, now, before),
  ]
}

export function updateMessage(
  sqlite: DatabaseSync,
  roomId: string,
  messageId: string,
  append: string | null,
  now: string,
): DomainEventDraft[] {
  const value = sqlite
    .prepare('SELECT * FROM messages WHERE id = ? AND room_id = ?')
    .get(messageId, roomId)
  if (!value) return []
  const message = messageFromRow(value)
  // Completion is terminal: delayed deltas and repeated scenario playback cannot alter it.
  if (!message.streaming) return []
  if (append !== null) {
    const text = message.parts.findLast((part) => part.kind === 'text')
    if (text?.kind === 'text') text.text += append
    else message.parts.push({ kind: 'text', text: append })
  } else message.streaming = false
  sqlite
    .prepare(
      'UPDATE messages SET parts = ?, streaming = ?, updated_at = ?, version = version + 1 WHERE id = ?',
    )
    .run(JSON.stringify(message.parts), Number(message.streaming), now, messageId)
  // The completion event repeats every part; a very long reply would make one huge frame. Clients already
  // hold the streamed text, so past the bound they keep it and a reload reads the stored message.
  const parts = JSON.stringify(message.parts).length <= MAX_COMPLETION_PARTS_CHARS
  return append === null
    ? [
        {
          type: 'message.completed',
          data: parts ? { messageId, roomId, parts: message.parts } : { messageId, roomId },
        },
      ]
    : [{ type: 'message.delta', data: { messageId, roomId, append } }]
}

/**
 * Soft delete (PLAN 5.20): the row stays for runs and audit, every read leaves it out. Idempotent; a message that is
 * still streaming is refused so its run never writes into a hidden message.
 */
export function deleteMessage(
  sqlite: DatabaseSync,
  roomId: string,
  messageId: string,
  now: string,
): DomainEventDraft[] {
  const row = z
    .object({ streaming: z.union([z.literal(0), z.literal(1)]), deleted_at: z.string().nullable() })
    .nullish()
    .parse(
      sqlite
        .prepare('SELECT streaming, deleted_at FROM messages WHERE id = ? AND room_id = ?')
        .get(messageId, roomId),
    )
  if (!row) throw new HttpError(404, 'not_found', 'Unknown message')
  if (row.deleted_at !== null) return []
  if (row.streaming === 1)
    throw new HttpError(409, 'conflict', 'This message is still being written')
  // Same rule as an edit: a reply that is being written blocks the delete, replies still queued are cancelled.
  const answering = sqlite
    .prepare(
      `SELECT 1 FROM message_runs r JOIN messages m ON m.id = r.message_id
       WHERE (r.parent_message_id = ? OR r.chain_id = ?) AND m.deleted_at IS NULL AND m.streaming = 1`,
    )
    .get(messageId, messageId)
  if (answering)
    throw new HttpError(409, 'conflict', 'An agent is still answering this message; stop it first')
  const before = readRoom(sqlite, roomId, roomRow(sqlite, roomId).updated_at)
  sqlite
    .prepare(
      "UPDATE message_runs SET state = 'failed' WHERE state = 'pending' AND (parent_message_id = ? OR chain_id = ?)",
    )
    .run(messageId, messageId)
  sqlite
    .prepare(
      'UPDATE messages SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?',
    )
    .run(now, now, messageId)
  releaseMessageMedia(sqlite, [messageId])
  return [
    { type: 'message.deleted', data: { roomId, messageId } },
    ...markStaleSummaries(sqlite, roomId, now),
    ...roomChanged(sqlite, roomId, now, before),
  ]
}

const MAX_COMPLETION_PARTS_CHARS = 256 * 1024

const CursorSchema = z
  .object({ roomId: z.string(), createdAt: z.iso.datetime(), id: z.string().min(1) })
  .strict()
export function decodeMessageCursor(value: string, roomId: string) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding')
    const cursor = CursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown,
    )
    if (cursor.roomId !== roomId) throw new Error('Wrong room')
    return cursor
  } catch {
    throw new HttpError(400, 'bad_request', 'Invalid message cursor')
  }
}

export function messagePage(
  sqlite: DatabaseSync,
  roomId: string,
  limit: number,
  before?: z.infer<typeof CursorSchema>,
) {
  roomRow(sqlite, roomId)
  const rows = before
    ? sqlite
        .prepare(
          'SELECT * FROM messages WHERE room_id = ? AND deleted_at IS NULL AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?',
        )
        .all(roomId, before.createdAt, before.id, limit + 1)
    : sqlite
        .prepare(
          'SELECT * FROM messages WHERE room_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?',
        )
        .all(roomId, limit + 1)
  const items = rows.slice(0, limit).map(messageFromRow)
  const last = items.at(-1)
  const nextCursor =
    rows.length > limit && last
      ? Buffer.from(JSON.stringify({ roomId, createdAt: last.createdAt, id: last.id })).toString(
          'base64url',
        )
      : null
  return { items, nextCursor }
}

export function markRoomRead(
  sqlite: DatabaseSync,
  roomId: string,
  now: string,
  newest: Message | undefined,
): DomainEventDraft[] {
  const before = readRoom(sqlite, roomId, roomRow(sqlite, roomId).updated_at)
  if (newest)
    sqlite
      .prepare(
        `INSERT INTO room_reads (room_id, last_read_message_created_at, last_read_message_id)
    VALUES (?, ?, ?) ON CONFLICT (room_id) DO UPDATE SET
    last_read_message_created_at = excluded.last_read_message_created_at, last_read_message_id = excluded.last_read_message_id
    WHERE (excluded.last_read_message_created_at, excluded.last_read_message_id) > (room_reads.last_read_message_created_at, room_reads.last_read_message_id)`,
      )
      .run(roomId, newest.createdAt, newest.id)
  return roomChanged(sqlite, roomId, now, before)
}
