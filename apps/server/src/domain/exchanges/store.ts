import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ExchangeSchema, JobSchema, type Exchange, type Job } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'

// Rows of jobs and exchanges as the contract shapes them, and the events that announce them (PLAN 11.1b).

const JobRowSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  title: z.string(),
  state: JobSchema.shape.state,
  holder_agent_id: z.string().nullable(),
  is_default: z.union([z.literal(0), z.literal(1)]),
  exchange_budget: z.int(),
  job_turn_limit: z.int(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type JobRow = z.infer<typeof JobRowSchema>

const ExchangeRowSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  room_id: z.string(),
  kind: ExchangeSchema.shape.kind,
  parent_id: z.string().nullable(),
  from_agent_id: z.string(),
  to_agent_id: z.string(),
  state: ExchangeSchema.shape.state,
  round: z.int(),
  turns_used: z.int(),
  budget: z.int(),
  outcome: ExchangeSchema.shape.outcome,
  ended_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ExchangeRow = z.infer<typeof ExchangeRowSchema>

const jobFromRow = (row: JobRow): Job =>
  JobSchema.parse({
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    state: row.state,
    holderAgentId: row.holder_agent_id,
    isDefault: row.is_default === 1,
    exchangeBudget: row.exchange_budget,
    jobTurnLimit: row.job_turn_limit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

const exchangeFromRow = (row: ExchangeRow): Exchange =>
  ExchangeSchema.parse({
    id: row.id,
    jobId: row.job_id,
    roomId: row.room_id,
    kind: row.kind,
    parentId: row.parent_id,
    from: row.from_agent_id,
    to: row.to_agent_id,
    state: row.state,
    round: row.round,
    turnsUsed: row.turns_used,
    budget: row.budget,
    outcome: row.outcome,
    endedReason: row.ended_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

const EXCHANGE_SELECT = 'SELECT x.*, j.room_id FROM exchanges x JOIN jobs j ON j.id = x.job_id'

export function jobRow(sqlite: DatabaseSync, jobId: string): JobRow | null {
  const row = sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId)
  return row === undefined ? null : JobRowSchema.parse(row)
}

export function exchangeRow(sqlite: DatabaseSync, id: string): ExchangeRow | null {
  const row = sqlite.prepare(`${EXCHANGE_SELECT} WHERE x.id = ?`).get(id)
  return row === undefined ? null : ExchangeRowSchema.parse(row)
}

export function listJobs(sqlite: DatabaseSync, roomId: string): Job[] {
  return z
    .array(JobRowSchema)
    .parse(
      sqlite
        .prepare(
          "SELECT * FROM jobs WHERE room_id = ? AND state != 'closed' ORDER BY is_default DESC, created_at, id",
        )
        .all(roomId),
    )
    .map(jobFromRow)
}

export function listExchanges(sqlite: DatabaseSync, jobId: string): Exchange[] {
  return z
    .array(ExchangeRowSchema)
    .parse(
      sqlite
        .prepare(`${EXCHANGE_SELECT} WHERE x.job_id = ? ORDER BY x.created_at, x.id`)
        .all(jobId),
    )
    .map(exchangeFromRow)
}

export const jobEvent = (sqlite: DatabaseSync, jobId: string): DomainEventDraft[] => {
  const row = jobRow(sqlite, jobId)
  return row ? [{ type: 'job.upserted', data: jobFromRow(row) }] : []
}
export const exchangeEvent = (sqlite: DatabaseSync, id: string): DomainEventDraft[] => {
  const row = exchangeRow(sqlite, id)
  return row ? [{ type: 'exchange.upserted', data: exchangeFromRow(row) }] : []
}

/** Changes a job's holder and/or state; returns the event when anything changed. */
export function updateJob(
  sqlite: DatabaseSync,
  jobId: string,
  change: { holder?: string; state?: Job['state'] },
  now: string,
): DomainEventDraft[] {
  const before = jobRow(sqlite, jobId)
  if (!before) return []
  const holder = change.holder ?? before.holder_agent_id
  const state = change.state ?? before.state
  if (holder === before.holder_agent_id && state === before.state) return []
  sqlite
    .prepare(
      'UPDATE jobs SET holder_agent_id = ?, state = ?, updated_at = ?, version = version + 1 WHERE id = ?',
    )
    .run(holder, state, now, jobId)
  return jobEvent(sqlite, jobId)
}

export function updateExchange(
  sqlite: DatabaseSync,
  id: string,
  change: Partial<Pick<ExchangeRow, 'state' | 'round' | 'outcome' | 'ended_reason'>>,
  now: string,
): DomainEventDraft[] {
  const sets = Object.keys(change).map((key) => `${key} = ?`)
  if (!sets.length) return []
  sqlite
    .prepare(
      `UPDATE exchanges SET ${sets.join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`,
    )
    .run(...Object.values(change), now, id)
  return exchangeEvent(sqlite, id)
}

export function openExchange(
  sqlite: DatabaseSync,
  req: {
    jobId: string
    kind: ExchangeRow['kind']
    parentId: string | null
    from: string
    to: string
    turnId: string
  },
  now: string,
): string {
  const job = jobRow(sqlite, req.jobId)
  if (!job) throw new Error(`job ${req.jobId} not found`)
  const id = `xch_${randomBytes(12).toString('hex')}`
  sqlite
    .prepare(
      `INSERT INTO exchanges (id, job_id, kind, parent_id, from_agent_id, to_agent_id, state, budget, opened_by_turn_id,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?)`,
    )
    .run(
      id,
      req.jobId,
      req.kind,
      req.parentId,
      req.from,
      req.to,
      job.exchange_budget,
      req.turnId,
      now,
      now,
    )
  return id
}

/** A new job (thread) in a room; its agents get sessions of their own (`score-<room>-<job>-<agent>`). */
export function createJob(
  sqlite: DatabaseSync,
  roomId: string,
  title: string,
  now: string,
): { job: Job; drafts: DomainEventDraft[] } {
  const room = sqlite.prepare('SELECT routing FROM rooms WHERE id = ?').get(roomId) as
    { routing: string } | undefined
  if (!room) throw new HttpError(404, 'not_found', 'Couldn’t find that room.')
  // A room on @mentions shows one thread; its jobs come when it moves to exchanges (11.11).
  if (room.routing !== 'exchanges')
    throw new HttpError(409, 'conflict', 'Only rooms that route with exchanges hold several jobs.')
  const id = `job_${randomBytes(12).toString('hex')}`
  sqlite
    .prepare(
      `INSERT INTO jobs (id, room_id, title, session_scheme, created_at, updated_at)
       VALUES (?, ?, ?, 'job', ?, ?)`,
    )
    .run(id, roomId, title, now, now)
  const drafts = jobEvent(sqlite, id)
  return { job: (drafts[0] as { data: Job }).data, drafts }
}
