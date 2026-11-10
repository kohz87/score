import { releaseMessageMedia } from './media-refs.ts'
import type { DatabaseSync } from 'node:sqlite'
import { MessageSchema, MessageSpeedSchema, type MessageSpeed, type Message } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { markStaleSummaries } from './summary-stale.ts'
import { jobEvent } from './exchanges/store.ts'
import { readRoom } from './rooms-read.ts'
import { MessageRowSchema, roomRow } from './rooms-rows.ts'
import { roomChanged } from './rooms-write.ts'

/** A malformed or old-shaped stored value is no speed: one bad row must never break a room's message list. */
function speedOf(stored: string | null | undefined): MessageSpeed | null {
  if (!stored) return null
  try {
    const parsed = MessageSpeedSchema.safeParse(JSON.parse(stored))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
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
    ...(row.alternative_of ? { alternativeOf: row.alternative_of } : {}),
    ...(row.effort ? { effort: row.effort } : {}),
    ...(row.reply_kind ? { retryable: row.reply_kind === 'person' } : {}),
    ...(speedOf(row.speed) ? { speed: speedOf(row.speed) } : {}),
  })
}

/**
 * 3.5.0: whether an agent's reply answers the person's own message (Retry and Try another apply) or came from a
 * hand-off, a summary or an orchestration turn (they don't) — the same rule `retryReply` enforces. Null when no run is
 * recorded for it yet.
 */
function replyKind(sqlite: DatabaseSync, messageId: string): 'person' | 'handoff' | null {
  const run = sqlite
    .prepare(
      'SELECT hop, from_agent_id, purpose, orchestration_attempt_id FROM message_runs WHERE message_id = ?',
    )
    .get(messageId) as
    | {
        hop: number
        from_agent_id: string | null
        purpose: string | null
        orchestration_attempt_id: string | null
      }
    | undefined
  if (!run) return null
  return run.hop === 0 &&
    run.from_agent_id === null &&
    !run.purpose &&
    !run.orchestration_attempt_id
    ? 'person'
    : 'handoff'
}

const MAX_COMPLETION_PARTS_CHARS = 256 * 1024

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
    (id, room_id, author_kind, author_agent_id, "to", parts, refs, streaming, created_at, updated_at, edits, progress_at, job_id, alternative_of, reply_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
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
      message.alternativeOf ?? null,
      message.author.kind === 'agent' ? replyKind(sqlite, message.id) : null,
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
          data: {
            messageId,
            roomId,
            ...(parts ? { parts: message.parts } : {}),
            ...(message.speed ? { speed: message.speed } : {}),
          },
        },
      ]
    : [{ type: 'message.delta', data: { messageId, roomId, append } }]
}

/**
 * Soft delete (PLAN 5.20): the row stays for runs and audit, every read leaves it out. Idempotent; a message that is
 * still streaming is refused so its run never writes into a hidden message.
 */
/** A delete's checks: false when the message is already deleted; 404/409 when it can't be deleted now. */
function assertDeletable(sqlite: DatabaseSync, roomId: string, messageId: string): boolean {
  const row = z
    .object({ streaming: z.union([z.literal(0), z.literal(1)]), deleted_at: z.string().nullable() })
    .nullish()
    .parse(
      sqlite
        .prepare('SELECT streaming, deleted_at FROM messages WHERE id = ? AND room_id = ?')
        .get(messageId, roomId),
    )
  if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that message.')
  if (row.deleted_at !== null) return false
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
  return true
}
export function deleteMessage(
  sqlite: DatabaseSync,
  roomId: string,
  messageId: string,
  now: string,
): DomainEventDraft[] {
  if (!assertDeletable(sqlite, roomId, messageId)) return []
  const before = readRoom(sqlite, roomId, roomRow(sqlite, roomId).updated_at)
  const job = hideMessage(sqlite, messageId, now)
  return [
    { type: 'message.deleted', data: { roomId, messageId } },
    ...markStaleSummaries(sqlite, roomId, now),
    ...roomChanged(sqlite, roomId, now, before),
    ...(job ? jobEvent(sqlite, job) : []),
  ]
}
/** The writes of a delete, after its checks: queued replies cancelled, the message hidden, its media released. */
function hideMessage(sqlite: DatabaseSync, messageId: string, now: string): string | null {
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
  return (
    sqlite.prepare('SELECT job_id FROM messages WHERE id = ?').get(messageId) as {
      job_id: string | null
    }
  ).job_id
}

/**
 * Clears a one-to-one's main conversation (2.0.11): every live message of a direct room's default thread is deleted
 * the same way as one at a time (Score-only; the agent's Hermes session may still remember). Other chats in the room
 * (its jobs) are untouched. One transaction: a message still being written stops the whole clear.
 */
export function clearDirectThread(
  sqlite: DatabaseSync,
  roomId: string,
  now: string,
): { cleared: number; events: DomainEventDraft[] } {
  if (roomRow(sqlite, roomId).role !== 'direct')
    throw new HttpError(409, 'conflict', 'Only a one-to-one’s main chat can be cleared.')
  const ids = z
    .array(z.object({ id: z.string() }))
    .parse(
      sqlite
        .prepare(
          `SELECT m.id FROM messages m LEFT JOIN jobs j ON j.id = m.job_id
           WHERE m.room_id = ? AND m.deleted_at IS NULL AND (m.job_id IS NULL OR j.is_default = 1)
           ORDER BY m.created_at DESC, m.id DESC`,
        )
        .all(roomId),
    )
    .map((row) => row.id)
  if (ids.length === 0) return { cleared: 0, events: [] }
  // Each message gets a delete's checks and writes and its own `message.deleted`; the room, summary and job updates
  // go out once for the whole clear instead of once per message.
  const before = readRoom(sqlite, roomId, roomRow(sqlite, roomId).updated_at)
  const jobs = new Set<string>()
  const events: DomainEventDraft[] = []
  for (const id of ids) {
    assertDeletable(sqlite, roomId, id)
    const job = hideMessage(sqlite, id, now)
    if (job) jobs.add(job)
    events.push({ type: 'message.deleted', data: { roomId, messageId: id } })
  }
  events.push(
    ...markStaleSummaries(sqlite, roomId, now),
    ...roomChanged(sqlite, roomId, now, before),
    ...[...jobs].flatMap((job) => jobEvent(sqlite, job)),
  )
  return { cleared: ids.length, events }
}
