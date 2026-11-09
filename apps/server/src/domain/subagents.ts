import type { DatabaseSync } from 'node:sqlite'
import { SUBAGENT_LIMITS, type JobSubagents, type JobSubagentsRequest } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'

// Subagents' limits and count (decision 173, docs/briefs/SA-subagents.md). An agent has a ceiling; a job can only narrow
// it, and has a total. The most specific wins, and what's enforced is the narrowest of the two.

const JobLimitsSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  subagents_enabled: z.int(),
  subagents_max_concurrent: z.int().nullable(),
  subagents_max_total: z.int(),
  subagents_used: z.int(),
})

const jobLimits = (sqlite: DatabaseSync, jobId: string) => {
  const row = sqlite
    .prepare(
      `SELECT id, room_id, subagents_enabled, subagents_max_concurrent, subagents_max_total, subagents_used
       FROM jobs WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(jobId)
  return row === undefined ? null : JobLimitsSchema.parse(row)
}

const asView = (row: z.infer<typeof JobLimitsSchema>): JobSubagents => ({
  enabled: row.subagents_enabled === 1,
  maxConcurrent: row.subagents_max_concurrent,
  maxTotal: row.subagents_max_total,
  used: row.subagents_used,
})

/** Sent for every room: a run's room has no `job.upserted`, and it is how a change reaches the session files. */
export function subagentsEvent(sqlite: DatabaseSync, jobId: string): DomainEventDraft[] {
  const row = jobLimits(sqlite, jobId)
  return row
    ? [{ type: 'subagents.changed', data: { jobId, roomId: row.room_id, subagents: asView(row) } }]
    : []
}

export function changeJobSubagents(
  sqlite: DatabaseSync,
  jobId: string,
  change: JobSubagentsRequest,
): DomainEventDraft[] {
  const row = jobLimits(sqlite, jobId)
  if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
  sqlite
    .prepare(
      `UPDATE jobs SET subagents_enabled = ?, subagents_max_concurrent = ?, subagents_max_total = ? WHERE id = ?`,
    )
    .run(
      change.enabled === undefined ? row.subagents_enabled : change.enabled ? 1 : 0,
      change.maxConcurrent === undefined ? row.subagents_max_concurrent : change.maxConcurrent,
      change.maxTotal ?? row.subagents_max_total,
      jobId,
    )
  return subagentsEvent(sqlite, jobId)
}

/** "Allow N more": N from where the job stands now, so a total passed by a few doesn't swallow them. */
export function allowMoreSubagents(
  sqlite: DatabaseSync,
  jobId: string,
  count: number,
): DomainEventDraft[] {
  sqlite
    .prepare(
      `UPDATE jobs SET subagents_max_total = MIN(?, MAX(subagents_used, subagents_max_total) + ?) WHERE id = ?`,
    )
    .run(SUBAGENT_LIMITS.maxTotal, count, jobId)
  return subagentsEvent(sqlite, jobId)
}

export function subagentTotalReached(sqlite: DatabaseSync, jobId: string): boolean {
  const row = jobLimits(sqlite, jobId)
  return row !== null && row.subagents_used >= row.subagents_max_total
}

function addUse(sqlite: DatabaseSync, jobId: string): DomainEventDraft[] {
  sqlite.prepare('UPDATE jobs SET subagents_used = subagents_used + 1 WHERE id = ?').run(jobId)
  return subagentsEvent(sqlite, jobId)
}

export const jobOfSession = (sqlite: DatabaseSync, sessionId: string): string | null =>
  (
    sqlite.prepare('SELECT job_id FROM subagent_sessions WHERE session_id = ?').get(sessionId) as
      { job_id: string } | undefined
  )?.job_id ?? null

/** Hermes: `subagent_start` names its parent's session. A session Score has no job for isn't counted. */
export function countSubagentOfSession(
  sqlite: DatabaseSync,
  sessionId: string,
): DomainEventDraft[] {
  const jobId = jobOfSession(sqlite, sessionId)
  return jobId ? addUse(sqlite, jobId) : []
}

/** Claude Code: its `Agent` call. Its program has no limit Score can set, so this count is the only control. */
export const countSubagentOfJob = addUse

export function rememberSubagentSession(
  sqlite: DatabaseSync,
  sessionId: string,
  profile: string,
  jobId: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO subagent_sessions (session_id, profile, job_id) VALUES (?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET profile = excluded.profile, job_id = excluded.job_id`,
    )
    .run(sessionId, profile, jobId)
}

export function subagentSessionsOf(
  sqlite: DatabaseSync,
  jobId: string,
): { sessionId: string; profile: string }[] {
  return (
    sqlite
      .prepare('SELECT session_id, profile FROM subagent_sessions WHERE job_id = ?')
      .all(jobId) as { session_id: string; profile: string }[]
  ).map((row) => ({ sessionId: row.session_id, profile: row.profile }))
}

export interface AgentCeiling {
  enabled: boolean
  maxConcurrent: number
}

export function ceilingOf(sqlite: DatabaseSync, profile: string): AgentCeiling {
  const row = sqlite
    .prepare('SELECT enabled, max_concurrent FROM subagent_agents WHERE profile = ?')
    .get(profile) as { enabled: number; max_concurrent: number } | undefined
  return row
    ? { enabled: row.enabled === 1, maxConcurrent: row.max_concurrent }
    : { enabled: true, maxConcurrent: SUBAGENT_LIMITS.defaultConcurrent }
}

export function setCeiling(
  sqlite: DatabaseSync,
  profile: string,
  change: Partial<AgentCeiling>,
): void {
  const next = { ...ceilingOf(sqlite, profile), ...change }
  sqlite
    .prepare(
      `INSERT INTO subagent_agents (profile, enabled, max_concurrent) VALUES (?, ?, ?)
       ON CONFLICT (profile) DO UPDATE SET enabled = excluded.enabled, max_concurrent = excluded.max_concurrent`,
    )
    .run(profile, next.enabled ? 1 : 0, next.maxConcurrent)
}

/** The narrowest of the agent's ceiling and the job's limits. With no job, the agent's ceiling and the default total. */
export function effectiveLimits(
  sqlite: DatabaseSync,
  profile: string,
  jobId: string | null,
): { enabled: boolean; maxConcurrent: number; maxTotal: number; used: number } {
  const ceiling = ceilingOf(sqlite, profile)
  const job = jobId ? jobLimits(sqlite, jobId) : null
  return {
    enabled: ceiling.enabled && (job === null || job.subagents_enabled === 1),
    maxConcurrent: Math.min(ceiling.maxConcurrent, job?.subagents_max_concurrent ?? Infinity),
    maxTotal: job?.subagents_max_total ?? SUBAGENT_LIMITS.defaultTotal,
    used: job?.subagents_used ?? 0,
  }
}
