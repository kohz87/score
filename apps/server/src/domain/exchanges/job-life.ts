import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { jobEvent, jobRow, type JobRow } from './store.ts'

// A job's own lifecycle from the job menu (decision 121, D6): rename, close and reopen, delete and undo.

const LifeSchema = z.object({ deleted_at: z.string().nullable(), closed_at: z.string().nullable() })

function life(sqlite: DatabaseSync, jobId: string): z.infer<typeof LifeSchema> {
  return LifeSchema.parse(
    sqlite.prepare('SELECT deleted_at, closed_at FROM jobs WHERE id = ?').get(jobId),
  )
}

/** The job, refusing the default job: it is the room's own thread, named after the room and never closed or deleted. */
function namedJob(sqlite: DatabaseSync, jobId: string): JobRow {
  const job = jobRow(sqlite, jobId)
  if (!job || life(sqlite, jobId).deleted_at)
    throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
  if (job.is_default)
    throw new HttpError(
      409,
      'conflict',
      'The room’s own thread follows the room: rename or delete the room instead.',
    )
  return job
}

/** Work still running or queued in the job: closing or deleting waits for it (the person stops the job first). */
function busy(sqlite: DatabaseSync, jobId: string): boolean {
  return Boolean(
    sqlite
      .prepare(
        `SELECT 1 FROM message_runs WHERE job_id = ? AND purpose IS NULL AND state IN ('pending', 'active') LIMIT 1`,
      )
      .get(jobId),
  )
}

function refuseWhileBusy(sqlite: DatabaseSync, jobId: string, what: string): void {
  if (busy(sqlite, jobId))
    throw new HttpError(
      409,
      'conflict',
      `The job is still working. Stop it first, then ${what} it.`,
    )
}

function touch(sqlite: DatabaseSync, jobId: string, sets: string, values: unknown[], now: string) {
  sqlite
    .prepare(`UPDATE jobs SET ${sets}, updated_at = ?, version = version + 1 WHERE id = ?`)
    .run(...(values as never[]), now, jobId)
}

export function renameJob(
  sqlite: DatabaseSync,
  jobId: string,
  title: string,
  now: string,
): DomainEventDraft[] {
  const job = namedJob(sqlite, jobId)
  if (job.title === title) return []
  touch(sqlite, jobId, 'title = ?', [title], now)
  return jobEvent(sqlite, jobId)
}

export function closeJob(sqlite: DatabaseSync, jobId: string, now: string): DomainEventDraft[] {
  const job = namedJob(sqlite, jobId)
  if (job.state === 'closed') return []
  refuseWhileBusy(sqlite, jobId, 'close')
  touch(sqlite, jobId, "state = 'closed', closed_at = ?", [now], now)
  return jobEvent(sqlite, jobId)
}

export function reopenJob(sqlite: DatabaseSync, jobId: string, now: string): DomainEventDraft[] {
  const job = namedJob(sqlite, jobId)
  if (job.state !== 'closed') return []
  touch(sqlite, jobId, "state = 'open', closed_at = NULL", [], now)
  return jobEvent(sqlite, jobId)
}

/**
 * Soft delete. The job's messages are soft-deleted with the job's own timestamp, so every reader that already leaves
 * deleted messages out (room reads, unread counts, search, exports, agents' context) leaves them out too, and undo
 * restores exactly those (messages deleted one by one before stay deleted).
 */
export function deleteJob(sqlite: DatabaseSync, jobId: string, now: string): DomainEventDraft[] {
  const job = jobRow(sqlite, jobId)
  if (!job) throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
  if (life(sqlite, jobId).deleted_at) return []
  namedJob(sqlite, jobId)
  refuseWhileBusy(sqlite, jobId, 'delete')
  touch(sqlite, jobId, 'deleted_at = ?', [now], now)
  sqlite
    .prepare('UPDATE messages SET deleted_at = ? WHERE job_id = ? AND deleted_at IS NULL')
    .run(now, jobId)
  return [{ type: 'job.deleted', data: { id: jobId, roomId: job.room_id } }]
}

export function restoreJob(sqlite: DatabaseSync, jobId: string, now: string): DomainEventDraft[] {
  const job = jobRow(sqlite, jobId)
  if (!job) throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
  const { deleted_at: deletedAt } = life(sqlite, jobId)
  if (!deletedAt) return jobEvent(sqlite, jobId)
  sqlite
    .prepare('UPDATE messages SET deleted_at = NULL WHERE job_id = ? AND deleted_at = ?')
    .run(jobId, deletedAt)
  touch(sqlite, jobId, 'deleted_at = NULL', [], now)
  return jobEvent(sqlite, jobId)
}

/** A person's message into a closed or deleted job is refused; the job menu reopens or undoes first. */
export function assertJobOpen(sqlite: DatabaseSync, jobId: string): void {
  const job = jobRow(sqlite, jobId)
  if (!job) return
  if (life(sqlite, jobId).deleted_at)
    throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
  if (job.state === 'closed')
    throw new HttpError(409, 'conflict', 'That job is closed. Reopen it to write in it.')
}
