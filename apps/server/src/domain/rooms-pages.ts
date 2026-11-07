import type { DatabaseSync } from 'node:sqlite'
import type { Message } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { defaultJobId } from './job-sessions.ts'
import { jobEvent } from './exchanges/store.ts'
import { messageFromRow } from './rooms-messages.ts'
import { readRoom } from './rooms-read.ts'
import { roomRow } from './rooms-rows.ts'
import { roomChanged } from './rooms-write.ts'

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
  /** 3.22.0: every non-deleted job of the room in one time-ordered read (a chat is one conversation). */
  all = false,
) {
  roomRow(sqlite, roomId)
  const job = all ? '' : (jobId ?? defaultJobId(sqlite, roomId) ?? '')
  // A deleted job's messages leave with it, so a message whose job is deleted is left out here too.
  const scope = all
    ? 'room_id = ? AND deleted_at IS NULL AND (job_id IS NULL OR job_id IN (SELECT id FROM jobs WHERE room_id = messages.room_id AND deleted_at IS NULL))'
    : 'room_id = ? AND job_id = ? AND deleted_at IS NULL'
  const scopeArgs = all ? [roomId] : [roomId, job]
  const rows = before
    ? sqlite
        .prepare(
          `SELECT * FROM messages WHERE ${scope} AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(...scopeArgs, before.createdAt, before.id, limit + 1)
    : sqlite
        .prepare(`SELECT * FROM messages WHERE ${scope} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...scopeArgs, limit + 1)
  const items = rows.slice(0, limit).map(messageFromRow)
  const last = items.at(-1)
  const nextCursor =
    rows.length > limit && last
      ? Buffer.from(JSON.stringify({ roomId, createdAt: last.createdAt, id: last.id })).toString(
          'base64url',
        )
      : null
  return { items, nextCursor, jobId: job || null }
}

/** Jobs of the room that still hold an unread agent message older than `boundary` (a page's oldest message). */
export function jobsUnreadBefore(
  sqlite: DatabaseSync,
  roomId: string,
  boundary: { createdAt: string; id: string },
): Set<string> {
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT m.job_id AS job_id FROM messages m
      JOIN jobs j ON j.id = m.job_id AND j.deleted_at IS NULL
      LEFT JOIN job_reads r ON r.job_id = m.job_id
    WHERE m.room_id = ? AND m.author_kind = 'agent' AND m.deleted_at IS NULL AND
      (m.created_at, m.id) < (?, ?) AND
      (r.job_id IS NULL OR (m.created_at, m.id) > (r.last_read_message_created_at, r.last_read_message_id))`,
    )
    .all(roomId, boundary.createdAt, boundary.id) as { job_id: string }[]
  return new Set(rows.map((row) => row.job_id))
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
