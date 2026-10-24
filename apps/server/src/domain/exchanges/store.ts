import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ExchangeSchema,
  JobSchema,
  type Exchange,
  type ExchangeOption,
  type ExchangePauseReason,
  type Job,
} from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { redact } from '../../redact.ts'
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
  lead_extended: z.union([z.literal(0), z.literal(1)]),
  pause_reason: z
    .enum([
      'exchange_budget',
      'job_limit',
      'spend_cap',
      'cost_unknown',
      'turn_failed',
      'unreachable',
      'asker_gone',
      'no_decision',
      'author_stalled',
      'question_stopped',
    ])
    .nullable(),
  held: z.string().nullable(),
  decider_turn_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ExchangeRow = z.infer<typeof ExchangeRowSchema>

/** What lists show about a job besides its row (PLAN 11.2): unread, who is busy, last activity, a one-line summary. */
function jobFromRow(sqlite: DatabaseSync, row: JobRow): Job {
  const counts = sqlite
    .prepare(
      `SELECT count(*) AS n, MAX(m.created_at) AS last,
         SUM(m.author_kind = 'agent' AND (r.job_id IS NULL
           OR (m.created_at, m.id) > (r.last_read_message_created_at, r.last_read_message_id))) AS unread
       FROM messages m LEFT JOIN job_reads r ON r.job_id = m.job_id
       WHERE m.job_id = ? AND m.deleted_at IS NULL`,
    )
    .get(row.id) as { n: number; last: string | null; unread: number | null }
  const busy = sqlite
    .prepare(
      "SELECT DISTINCT agent_id FROM message_runs WHERE job_id = ? AND state = 'active' AND purpose IS NULL ORDER BY agent_id",
    )
    .all(row.id) as { agent_id: string }[]
  return JobSchema.parse({
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    state: row.state,
    holderAgentId: row.holder_agent_id,
    isDefault: row.is_default === 1,
    exchangeBudget: row.exchange_budget,
    jobTurnLimit: row.job_turn_limit,
    unread: counts.unread ?? 0,
    activeAgents: busy.map((agent) => agent.agent_id),
    lastMessageAt: counts.last,
    messageCount: counts.n,
    summary: jobSummaryLine(sqlite, row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

const SUMMARY_LINE = 160
/** The job's summary (its newest visible one), else the first line of its first message, redacted and bounded. */
function jobSummaryLine(sqlite: DatabaseSync, row: JobRow): string | null {
  const isSummary =
    "EXISTS (SELECT 1 FROM json_each(messages.parts) WHERE json_extract(value, '$.kind') = 'summary')"
  const visible = 'job_id = ? AND deleted_at IS NULL AND streaming = 0'
  const found = (sqlite
    .prepare(
      `SELECT parts FROM messages WHERE ${visible} AND ${isSummary} ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(row.id) ??
    sqlite
      .prepare(`SELECT parts FROM messages WHERE ${visible} ORDER BY created_at, id LIMIT 1`)
      .get(row.id)) as { parts: string } | undefined
  if (!found) return null
  const parts = z
    .array(z.object({ kind: z.string(), text: z.string().optional() }).loose())
    .parse(JSON.parse(found.parts))
  const text = parts.find((part) => part.kind === 'summary' || part.kind === 'text')?.text
  const line = text
    ?.split('\n')
    .find((piece) => piece.trim())
    ?.trim()
  if (!line) return null
  const clean = redact(line)
  return clean.length > SUMMARY_LINE ? `${clean.slice(0, SUMMARY_LINE - 1)}…` : clean
}

/** What the person can do about a paused exchange (docs/briefs/11.1c-budgets.md). */
export function pauseOptions(sqlite: DatabaseSync, row: ExchangeRow): ExchangeOption[] {
  const lead = (
    sqlite
      .prepare('SELECT r.lead_agent_id FROM rooms r JOIN jobs j ON j.room_id = r.id WHERE j.id = ?')
      .get(row.job_id) as { lead_agent_id: string | null } | undefined
  )?.lead_agent_id
  const leadMayDecide =
    lead &&
    lead !== row.from_agent_id &&
    lead !== row.to_agent_id &&
    row.lead_extended === 0 &&
    row.decider_turn_id === null
  // Reassigning only makes sense for the turn of the agent the exchange was opened to (not its author's side).
  const heldAgent = row.held ? (JSON.parse(row.held) as { agentId?: string }).agentId : undefined
  const reassign: ExchangeOption[] = heldAgent === row.to_agent_id ? ['reassign'] : []
  const options: Record<ExchangePauseReason, ExchangeOption[]> = {
    exchange_budget: [
      'more_turns',
      ...(leadMayDecide ? ['lead_decides' as const] : []),
      'step_in',
      'stop',
    ],
    job_limit: [
      'more_turns',
      ...(leadMayDecide ? ['lead_decides' as const] : []),
      'step_in',
      'stop',
    ],
    spend_cap: ['more_spend', 'step_in', 'stop'],
    cost_unknown: ['continue', 'step_in', 'stop'],
    turn_failed: ['retry', ...reassign, 'stop'],
    unreachable: ['retry', ...reassign, 'stop'],
    asker_gone: ['retry', ...(lead ? ['answer_to_lead' as const] : []), 'stop'],
    no_decision: ['ask_again', 'send_back', 'close'],
    author_stalled: ['ask_again', 'close'],
    question_stopped: ['continue', 'stop'],
  }
  return row.pause_reason ? options[row.pause_reason] : []
}

/** The agent whose turn in another job of the room holds this exchange's queued turn back (§4.6 row 3), or null. */
function queuedBehind(sqlite: DatabaseSync, row: ExchangeRow): Exchange['queuedBehind'] {
  if (row.state !== 'live') return null
  const waiting = sqlite
    .prepare(
      `SELECT q.agent_id, q.created_at FROM message_runs q
       WHERE q.exchange_id = ? AND q.state = 'pending' AND EXISTS (
         SELECT 1 FROM message_runs busy WHERE busy.room_id = q.room_id AND busy.agent_id = q.agent_id
           AND busy.state = 'active' AND busy.job_id IS NOT q.job_id)
       ORDER BY q.created_at LIMIT 1`,
    )
    .get(row.id) as { agent_id: string; created_at: string } | undefined
  return waiting ? { agentId: waiting.agent_id, since: waiting.created_at } : null
}

const exchangeFromRow = (sqlite: DatabaseSync, row: ExchangeRow): Exchange =>
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
    pause:
      row.pause_reason && ['paused_budget', 'waiting_on_you'].includes(row.state)
        ? { reason: row.pause_reason, options: pauseOptions(sqlite, row) }
        : null,
    queuedBehind: queuedBehind(sqlite, row),
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
    .map((row) => jobFromRow(sqlite, row))
}

export function listExchanges(sqlite: DatabaseSync, jobId: string): Exchange[] {
  return z
    .array(ExchangeRowSchema)
    .parse(
      sqlite
        .prepare(`${EXCHANGE_SELECT} WHERE x.job_id = ? ORDER BY x.created_at, x.id`)
        .all(jobId),
    )
    .map((row) => exchangeFromRow(sqlite, row))
}

export const jobEvent = (sqlite: DatabaseSync, jobId: string): DomainEventDraft[] => {
  const row = jobRow(sqlite, jobId)
  return row ? [{ type: 'job.upserted', data: jobFromRow(sqlite, row) }] : []
}
export const exchangeEvent = (sqlite: DatabaseSync, id: string): DomainEventDraft[] => {
  const row = exchangeRow(sqlite, id)
  return row ? [{ type: 'exchange.upserted', data: exchangeFromRow(sqlite, row) }] : []
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
  change: Partial<
    Pick<
      ExchangeRow,
      | 'state'
      | 'round'
      | 'outcome'
      | 'ended_reason'
      | 'pause_reason'
      | 'held'
      | 'decider_turn_id'
      | 'budget'
      | 'lead_extended'
    >
  >,
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
  const room = sqlite.prepare('SELECT routing, role FROM rooms WHERE id = ?').get(roomId) as
    { routing: string; role: string } | undefined
  if (!room) throw new HttpError(404, 'not_found', 'Couldn’t find that room.')
  // A room on @mentions shows one thread in the classic shell; its jobs come when it moves to exchanges (11.11). A
  // direct room may hold one-to-ones (11.2): the classic shell shows only its default job, and it has one agent.
  if (room.routing !== 'exchanges' && room.role !== 'direct')
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
