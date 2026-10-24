import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { continuationFor } from './outside-sessions.ts'

// Which Hermes session an agent's turn in a job goes into (PLAN 11.1a, docs/briefs/11.0-bold.md §3.3). This is the
// only place a Score session id is built; everything else asks here or looks one up with `sessionOwner`.

const JobRowSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  session_scheme: z.enum(['room', 'job']),
})
type JobRow = z.infer<typeof JobRowSchema>

function jobRow(sqlite: DatabaseSync, jobId: string): JobRow | null {
  const row = sqlite.prepare('SELECT id, room_id, session_scheme FROM jobs WHERE id = ?').get(jobId)
  return row === undefined ? null : JobRowSchema.parse(row)
}

/** The room's default job: every room has exactly one (migration 0080 and its trigger). */
export function defaultJobId(sqlite: DatabaseSync, roomId: string): string | null {
  const row = sqlite
    .prepare('SELECT id FROM jobs WHERE room_id = ? AND is_default = 1')
    .get(roomId) as { id: string } | undefined
  return row?.id ?? null
}

/** A room's own session of an agent, as it was named before jobs existed. */
const roomKey = (roomId: string, agentId: string) => `score-${roomId}-${agentId}`
const jobKey = (job: JobRow, agentId: string) => `score-${job.room_id}-${job.id}-${agentId}`

function roomSchemeSession(sqlite: DatabaseSync, roomId: string, agentId: string): string {
  // A room that continues an outside session runs in that Hermes session, not in its own.
  return continuationFor(sqlite, roomId, agentId).sessionId ?? roomKey(roomId, agentId)
}

/**
 * The session for `agentId`'s turns in a job. A turn row without a job (rows written before 0080 that the migration
 * could not place) falls back to its room's session, which is what it used before.
 */
export function sessionFor(
  sqlite: DatabaseSync,
  turn: { roomId: string; jobId: string | null; agentId: string },
): string {
  const job = turn.jobId === null ? null : jobRow(sqlite, turn.jobId)
  if (!job || job.session_scheme === 'room')
    return roomSchemeSession(sqlite, job?.room_id ?? turn.roomId, turn.agentId)
  const stored = sqlite
    .prepare('SELECT session_id FROM job_sessions WHERE job_id = ? AND agent_id = ?')
    .get(job.id, turn.agentId) as { session_id: string } | undefined
  return stored?.session_id ?? jobKey(job, turn.agentId)
}

/** The session of a room's default job: for room-scoped callers (one job per room until 11.1b). */
export function roomSession(sqlite: DatabaseSync, roomId: string, agentId: string): string {
  return sessionFor(sqlite, { roomId, jobId: defaultJobId(sqlite, roomId), agentId })
}

/** Records a 'job'-scheme session the first time a turn is reserved, so `sessionOwner` can find it. */
export function ensureJobSession(
  sqlite: DatabaseSync,
  jobId: string,
  agentId: string,
  now: string,
): void {
  const job = jobRow(sqlite, jobId)
  if (!job || job.session_scheme !== 'job') return
  sqlite
    .prepare(
      'INSERT OR IGNORE INTO job_sessions (job_id, agent_id, session_id, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(job.id, agentId, jobKey(job, agentId), now)
}

/**
 * Which room and job a Score session id belongs to, or null. Accepts the recorded job sessions, a continued outside
 * session, and the room key `score-<room>-<agent>`.
 */
export function sessionOwner(
  sqlite: DatabaseSync,
  agentId: string,
  sessionId: string,
): { roomId: string; jobId: string | null; continued: boolean } | null {
  const recorded = sqlite
    .prepare(
      'SELECT j.id AS job_id, j.room_id FROM job_sessions s JOIN jobs j ON j.id = s.job_id WHERE s.agent_id = ? AND s.session_id = ?',
    )
    .get(agentId, sessionId) as { job_id: string; room_id: string } | undefined
  if (recorded) return { roomId: recorded.room_id, jobId: recorded.job_id, continued: false }
  const continued = sqlite
    .prepare('SELECT room_id FROM room_sessions WHERE agent_id = ? AND session_id = ?')
    .get(agentId, sessionId) as { room_id: string } | undefined
  if (continued)
    return {
      roomId: continued.room_id,
      jobId: defaultJobId(sqlite, continued.room_id),
      continued: true,
    }
  const prefix = 'score-'
  const suffix = `-${agentId}`
  if (!sessionId.startsWith(prefix) || !sessionId.endsWith(suffix)) return null
  const roomId = sessionId.slice(prefix.length, sessionId.length - suffix.length)
  if (!sqlite.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId)) return null
  return { roomId, jobId: defaultJobId(sqlite, roomId), continued: false }
}
