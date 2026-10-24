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
import type { DeriveEvents, DomainEventDraft } from '../hub/ingest.ts'
import { markStaleSummaries } from './summary-stale.ts'
import { defaultJobId } from './job-sessions.ts'
import { jobEvent } from './exchanges/store.ts'
import { autoSummaryOf } from './room-summaries.ts'
import { actionable, ApprovalRowSchema } from './approval-store.ts'

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
  active_agents: z.string().default('[]'),
  role: z.enum(['team', 'direct', 'room']).default('room'),
  routing: z.enum(['mentions', 'exchanges']).default('mentions'),
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
  job_id: z.string().nullish(),
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
  if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that room.')
  return RoomRowSchema.parse(row)
}

let compatibility: (() => readonly string[]) | null = null
/** The features the compatibility check switched off, as the approvals API sees them (set once by the app). */
export function setRoomCompatibility(disabled: (() => readonly string[]) | null): void {
  compatibility = disabled
}

export const disabledFeatures = (): readonly string[] => compatibility?.() ?? []

type RoomRow = z.infer<typeof RoomRowSchema>

/**
 * What makes members busy, read once for many rooms (PLAN 10.11; the room stage's rules in `stage-mood.ts`): replies
 * still streaming per room, and the pending actionable approvals with the rooms each belongs to (its card is there, or
 * its run was started there; none means a gateway approval that belongs everywhere its agent is a member).
 */
type ActivityIndex = {
  streaming: Map<string, Set<string>>
  approvals: { agent: string; rooms: string[] }[]
}

const StreamingRowSchema = z.object({ room_id: z.string(), author_agent_id: AgentIdSchema })

/** Two indexed queries, however many rooms; the optional scope narrows them to one room and its members. */
function activityIndex(
  sqlite: DatabaseSync,
  now: string,
  scope?: { roomId: string; agents: string[] },
): ActivityIndex {
  const streaming = new Map<string, Set<string>>()
  const rows = z.array(StreamingRowSchema).parse(
    scope
      ? sqlite
          .prepare(
            `SELECT DISTINCT room_id, author_agent_id FROM messages
             WHERE streaming = 1 AND deleted_at IS NULL AND author_kind = 'agent' AND room_id = ?`,
          )
          .all(scope.roomId)
      : sqlite
          .prepare(
            `SELECT DISTINCT room_id, author_agent_id FROM messages
             WHERE streaming = 1 AND deleted_at IS NULL AND author_kind = 'agent'`,
          )
          .all(),
  )
  for (const row of rows) {
    const set = streaming.get(row.room_id) ?? new Set<string>()
    set.add(row.author_agent_id)
    streaming.set(row.room_id, set)
  }
  const agentFilter = scope ? ` AND a.profile IN (${scope.agents.map(() => '?').join(', ')})` : ''
  const pending = sqlite
    .prepare(
      `SELECT a.*, m.room_id AS card_room, r.room_id AS run_room FROM approvals a
       LEFT JOIN messages m ON m.id = 'approval:' || a.id AND m.deleted_at IS NULL
       LEFT JOIN message_runs r ON r.run_id = a.run_id
       WHERE a.visible = 1 AND a.stage = 'human' AND a.phase = 'human_pending' AND a.status = 'pending'${agentFilter}`,
    )
    .all(...(scope?.agents ?? []))
  const disabled = disabledFeatures()
  const approvals: ActivityIndex['approvals'] = []
  for (const value of pending) {
    const approval = ApprovalRowSchema.parse(value)
    if (!actionable(sqlite, approval, { now: Date.parse(now), disabled })) continue
    const rooms = z
      .object({ card_room: z.string().nullable(), run_room: z.string().nullable() })
      .parse(value)
    approvals.push({
      agent: approval.profile,
      rooms: [...new Set([rooms.card_room, rooms.run_room].filter((id) => id !== null))],
    })
  }
  return { streaming, approvals }
}

const membersOf = (row: Pick<RoomRow, 'members' | 'lead_agent_id'>): string[] => {
  const members = z.array(AgentIdSchema).parse(JSON.parse(row.members))
  return row.lead_agent_id && !members.includes(row.lead_agent_id)
    ? [...members, row.lead_agent_id]
    : members
}

/** Members busy in a room: sorted by id. */
function busyAgents(
  row: Pick<RoomRow, 'id' | 'members' | 'lead_agent_id'>,
  index: ActivityIndex,
): string[] {
  const here = new Set(membersOf(row))
  const busy = new Set([...(index.streaming.get(row.id) ?? [])].filter((id) => here.has(id)))
  for (const approval of index.approvals)
    if (
      here.has(approval.agent) &&
      (approval.rooms.length === 0 || approval.rooms.includes(row.id))
    )
      busy.add(approval.agent)
  return [...busy].sort()
}

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
    SELECT count(*) AS count FROM messages m LEFT JOIN job_reads r ON r.job_id = m.job_id
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
    tags: row.tags === null ? nameTags(row.name) : z.array(z.string()).parse(JSON.parse(row.tags)),
    importedFrom: importedFrom(sqlite, row),
    autoSummary: autoSummaryOf(row.auto_summary),
    role: row.role,
    routing: row.routing,
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

export function insertRoom(
  sqlite: DatabaseSync,
  room: Pick<Room, 'id' | 'name' | 'kind' | 'leadAgentId' | 'members'> & {
    /** Stored as given (agentId, sessionId, source, label); `continued` is derived from room_sessions. */
    importedFrom?: { agentId: string; sessionId: string; source: string; label: string }
  },
  now: string,
): void {
  if (sqlite.prepare('SELECT id FROM rooms WHERE name = ?').get(room.name))
    throw new HttpError(409, 'conflict', 'A room with that name already exists.')
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
  rememberBusy(sqlite, id, after.activeAgents)
  return [{ type: 'room.upserted', data: after }]
}

/** The busy set last sent for a room: room updates go out only when the set differs from it. */
function rememberBusy(sqlite: DatabaseSync, id: string, busy: string[]): void {
  sqlite.prepare('UPDATE rooms SET active_agents = ? WHERE id = ?').run(JSON.stringify(busy), id)
}

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
    ...(row.job_id ? { jobId: row.job_id } : {}),
  })
}

export function storeMessage(
  sqlite: DatabaseSync,
  value: Message,
  now: string,
): DomainEventDraft[] {
  const message = MessageSchema.parse(value)
  const before = readRoom(sqlite, message.roomId, roomRow(sqlite, message.roomId).updated_at)
  if (
    message.jobId &&
    !sqlite
      .prepare('SELECT 1 FROM jobs WHERE id = ? AND room_id = ?')
      .get(message.jobId, message.roomId)
  )
    throw new HttpError(404, 'not_found', 'Couldn’t find that job in this room.')
  const result = sqlite
    .prepare(
      `INSERT INTO messages
    (id, room_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at, edits, progress_at, job_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
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
      message.jobId ?? null,
    )
  if (!result.changes) return []
  // Without a job the insert trigger placed it in the room's default job: the event says which.
  const stored = sqlite.prepare('SELECT job_id FROM messages WHERE id = ?').get(message.id) as {
    job_id: string | null
  }
  return [
    {
      type: 'message.created',
      data: { ...message, ...(stored.job_id ? { jobId: stored.job_id } : {}) },
    },
    ...roomChanged(sqlite, message.roomId, now, before),
    // Its job's count, unread and last activity changed (PLAN 11.2).
    ...(stored.job_id ? jobEvent(sqlite, stored.job_id) : []),
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
  if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that message.')
  if (row.deleted_at !== null) return []
  if (row.streaming === 1)
    throw new HttpError(409, 'conflict', 'This message is still being written.')
  // Same rule as an edit: a reply that is being written blocks the delete, replies still queued are cancelled.
  const answering = sqlite
    .prepare(
      `SELECT 1 FROM message_runs r JOIN messages m ON m.id = r.message_id
       WHERE (r.parent_message_id = ? OR r.chain_id = ?) AND m.deleted_at IS NULL AND m.streaming = 1`,
    )
    .get(messageId, messageId)
  if (answering)
    throw new HttpError(409, 'conflict', 'An agent is still answering this message. Stop it first.')
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
    throw new HttpError(
      400,
      'bad_request',
      'Couldn’t continue the messages from there. Reload and try again.',
    )
  }
}

export function messagePage(
  sqlite: DatabaseSync,
  roomId: string,
  limit: number,
  before?: z.infer<typeof CursorSchema>,
  /** PLAN 11.2: one job's messages; the room's default job when omitted (what the classic shell shows). */
  jobId?: string,
) {
  roomRow(sqlite, roomId)
  const job = jobId ?? defaultJobId(sqlite, roomId) ?? ''
  const rows = before
    ? sqlite
        .prepare(
          'SELECT * FROM messages WHERE room_id = ? AND job_id = ? AND deleted_at IS NULL AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?',
        )
        .all(roomId, job, before.createdAt, before.id, limit + 1)
    : sqlite
        .prepare(
          'SELECT * FROM messages WHERE room_id = ? AND job_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?',
        )
        .all(roomId, job, limit + 1)
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
  // Unread is per job (PLAN 11.1b): reading up to a message reads its job up to there.
  const jobId = newest && (newest.jobId ?? defaultJobId(sqlite, roomId))
  const jobBefore = jobId ? jobEvent(sqlite, jobId) : []
  if (newest && jobId)
    sqlite
      .prepare(
        `INSERT INTO job_reads (job_id, last_read_message_created_at, last_read_message_id)
    VALUES (?, ?, ?) ON CONFLICT (job_id) DO UPDATE SET
    last_read_message_created_at = excluded.last_read_message_created_at, last_read_message_id = excluded.last_read_message_id
    WHERE (excluded.last_read_message_created_at, excluded.last_read_message_id) > (job_reads.last_read_message_created_at, job_reads.last_read_message_id)`,
      )
      .run(jobId, newest.createdAt, newest.id)
  // Only a read that changed the job's unread count announces the job again.
  const jobAfter = jobId ? jobEvent(sqlite, jobId) : []
  return [
    ...roomChanged(sqlite, roomId, now, before),
    ...(JSON.stringify(jobAfter) === JSON.stringify(jobBefore) ? [] : jobAfter),
  ]
}
