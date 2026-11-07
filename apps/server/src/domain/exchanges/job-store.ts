import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { EXCHANGE_LIMITS, type Job, type JobCreateRequest } from '@score/contract'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { HttpError } from '../../errors.ts'
import { jobEvent } from './job-view.ts'

/**
 * 3.28.0 (decision 164): a group chat's one active job — not its own thread, not deleted, not finished. Rooms that held
 * several before keep them (the oldest is answered); a direct chat's one-to-ones are not limited.
 */
export function activeJob(
  sqlite: DatabaseSync,
  roomId: string,
  except?: string,
): { id: string; title: string } | null {
  const room = sqlite.prepare('SELECT role FROM rooms WHERE id = ?').get(roomId) as
    { role: string } | undefined
  if (!room || room.role === 'direct') return null
  const row = sqlite
    .prepare(
      `SELECT id, title FROM jobs WHERE room_id = ? AND is_default = 0 AND deleted_at IS NULL
         AND state IN ('open', 'working', 'waiting_on_you') AND id != ?
       ORDER BY created_at, id LIMIT 1`,
    )
    .get(roomId, except ?? '') as { id: string; title: string } | undefined
  return row ?? null
}

/** Refuses a second active job in a group chat: the person ends the running one first (`POST /api/jobs/:id/end`). */
export function assertNoActiveJob(sqlite: DatabaseSync, roomId: string, except?: string): void {
  const running = activeJob(sqlite, roomId, except)
  if (running)
    throw new HttpError(
      409,
      'job_running',
      `This chat already has a job running: “${running.title}”. Stop it first, or start this in another chat.`,
      { jobId: running.id, title: running.title },
    )
}

/** A new job (thread) in a room; its agents get sessions of their own (`score-<room>-<job>-<agent>`). */
export function createJob(
  sqlite: DatabaseSync,
  roomId: string,
  title: string,
  now: string,
  options: Omit<JobCreateRequest, 'title'> = {},
  /** The fake team's seed lays out a room that predates the one-job rule (several open topics). */
  rule: { allowBusy?: boolean } = {},
): { job: Job; drafts: DomainEventDraft[] } {
  const room = sqlite.prepare('SELECT routing, role FROM rooms WHERE id = ?').get(roomId) as
    { routing: string; role: string } | undefined
  if (!room) throw new HttpError(404, 'not_found', 'Couldn’t find that room.')
  // A room on @mentions (an orchestration or workflow run's since 11.11) is one thread its executor routes. A direct
  // room may hold one-to-ones (11.2): the classic shell shows only its default job, and it has one agent.
  if (room.routing !== 'exchanges' && room.role !== 'direct')
    throw new HttpError(409, 'conflict', 'Only rooms that route with exchanges hold several jobs.')
  if (!rule.allowBusy) assertNoActiveJob(sqlite, roomId)
  const id = `job_${randomBytes(12).toString('hex')}`
  sqlite
    .prepare(
      `INSERT INTO jobs (id, room_id, title, session_scheme, exchange_budget, job_turn_limit, spend_cap_usd,
                         recipe_kind, recipe_ref, created_at, updated_at)
       VALUES (?, ?, ?, 'job', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      roomId,
      title,
      options.exchangeBudget ?? EXCHANGE_LIMITS.exchangeBudget,
      options.jobTurnLimit ?? EXCHANGE_LIMITS.jobTurnLimit,
      options.spendCapUsd ?? null,
      options.recipe?.kind ?? null,
      options.recipe?.ref ?? null,
      now,
      now,
    )
  const drafts = jobEvent(sqlite, id)
  return { job: (drafts[0] as { data: Job }).data, drafts }
}

/** The newest visible message of a job: what a turn Score starts on the person's behalf is attached to. */
export function latestMessage(sqlite: DatabaseSync, jobId: string): string {
  const row = sqlite
    .prepare(
      'SELECT id FROM messages WHERE job_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1',
    )
    .get(jobId) as { id: string } | undefined
  if (!row) throw new HttpError(409, 'conflict', 'This job has no messages to continue from.')
  return row.id
}
