import type { DatabaseSync } from 'node:sqlite'
import type { AttemptDetail, AttemptSummary } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'

// Score's own record of Kanban worker attempts (5.17a-1). Separate from `runs`; stage 2 consumers read it through
// listAttempts(). Hermes timestamps are epoch seconds; times Score observed are ISO strings.

export const AttemptStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'blocked',
  'review_handoff',
  'changes_requested',
  'ended_unknown',
])

export const AttemptRowSchema = z.object({
  id: z.string().regex(/^kr_/),
  source_id: z.string(),
  history_id: z.string(),
  attempt_id: z.int(),
  task_id: z.string(),
  profile: z.string().nullable(),
  role: z.enum(['implementer', 'reviewer']).nullable(),
  status: AttemptStatusSchema,
  closure_reason: z.string().nullable(),
  started_at: z.int(),
  ended_at: z.int().nullable(),
  first_seen_open: z.int(),
  evidence: z.enum(['proven', 'partial']),
  classification_basis: z.string(),
  claim_lock: z.string().nullable(),
  claim_event_id: z.int().nullable(),
  claim_source_status: z.string().nullable(),
  worker_pid: z.int().nullable(),
  worker_started_at: z.string().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  task_snapshot: z.string().nullable(),
  revision: z.int(),
  content_hash: z.string(),
  copied_from: z.string().nullable(),
  first_seen: z.string(),
  last_observed_at: z.string(),
  observing: z.int(),
  observation_ended_at: z.string().nullable(),
  observation_resumed_at: z.string().nullable(),
  observation_gaps: z.int(),
  deleted_upstream_at: z.string().nullable(),
  refused_updates: z.int(),
  refused_hash: z.string().nullable(),
})
export type AttemptRow = z.infer<typeof AttemptRowSchema>

/** Kanban attempts run only when SCORE_KANBAN_ATTEMPTS=1; every consumer and writer checks this. */
export function kanbanAttemptsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SCORE_KANBAN_ATTEMPTS === '1'
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

export interface KanbanAttempt {
  id: string
  sourceId: string
  historyId: string
  /** Hermes `task_runs.id`: only ever used for ordering and display next to `startedAt`. */
  attemptId: number
  taskId: string
  /** Frozen claim profile; null = unknown (never the current assignee). */
  agentId: string | null
  role: 'implementer' | 'reviewer' | null
  status: z.infer<typeof AttemptStatusSchema>
  closureReason: string | null
  startedAt: string
  endedAt: string | null
  /** Set when observation stopped before the attempt ended; never an end time. */
  observationEndedAt: string | null
  observationResumedAt: string | null
  observationGaps: number
  evidence: 'proven' | 'partial'
  classificationBasis: string
  claimLock: string | null
  claimEventId: number | null
  claimSourceStatus: string | null
  workerPid: number | null
  workerStartedAt: string | null
  summary: string | null
  error: string | null
  taskSnapshot: { title: string; status: string; assignee: string | null } | null
  revision: number
  contentHash: string
  firstSeenOpen: boolean
  /** Same tuple seen in an earlier history of the source: excluded from aggregates. */
  copiedFrom: string | null
  deletedUpstreamAt: string | null
  refusedUpdates: number
  firstSeen: string
  lastObservedAt: string
  /** The history is no longer the live lineage of its source ("from an earlier copy of the board"). */
  historyState: 'active' | 'paused' | 'closed'
}

const SnapshotSchema = z.object({
  title: z.string(),
  status: z.string(),
  assignee: z.string().nullable(),
})

export function attemptView(
  row: AttemptRow,
  historyState: KanbanAttempt['historyState'],
): KanbanAttempt {
  const snapshot = row.task_snapshot
    ? SnapshotSchema.safeParse(JSON.parse(row.task_snapshot))
    : undefined
  return {
    id: row.id,
    sourceId: row.source_id,
    historyId: row.history_id,
    attemptId: row.attempt_id,
    taskId: row.task_id,
    agentId: row.profile,
    role: row.role,
    status: row.status,
    closureReason: row.closure_reason,
    startedAt: iso(row.started_at),
    endedAt: row.ended_at === null ? null : iso(row.ended_at),
    observationEndedAt: row.observation_ended_at,
    observationResumedAt: row.observation_resumed_at,
    observationGaps: row.observation_gaps,
    evidence: row.evidence,
    classificationBasis: row.classification_basis,
    claimLock: row.claim_lock,
    claimEventId: row.claim_event_id,
    claimSourceStatus: row.claim_source_status,
    workerPid: row.worker_pid,
    workerStartedAt: row.worker_started_at,
    summary: row.summary,
    error: row.error,
    taskSnapshot: snapshot?.success ? snapshot.data : null,
    revision: row.revision,
    contentHash: row.content_hash,
    firstSeenOpen: row.first_seen_open === 1,
    copiedFrom: row.copied_from,
    deletedUpstreamAt: row.deleted_upstream_at,
    refusedUpdates: row.refused_updates,
    firstSeen: row.first_seen,
    lastObservedAt: row.last_observed_at,
    historyState,
  }
}

export interface ListAttemptsInput {
  since: string
  until: string
  taskId?: string
  agentId?: string
  /** Aggregates count an attempt once: drop the ones copied from an earlier history of the same source. */
  excludeCopies?: boolean
}

/**
 * Attempts overlapping [since, until], oldest first by (startedAt, upstream attempt id) -- never by the opaque id.
 * An open attempt overlaps up to its observation boundary, or `until` while it is still observed.
 */
export function listAttempts(sqlite: DatabaseSync, input: ListAttemptsInput): KanbanAttempt[] {
  const { since, until, taskId, agentId, excludeCopies } = z
    .object({
      since: z.iso.datetime(),
      until: z.iso.datetime(),
      taskId: z.string().min(1).optional(),
      agentId: z.string().min(1).optional(),
      excludeCopies: z.boolean().optional(),
    })
    .parse(input)
  const from = Math.floor(Date.parse(since) / 1000)
  const to = Math.floor(Date.parse(until) / 1000)
  const clauses = ['a.started_at <= ?']
  const params: (string | number)[] = [to]
  // Closed attempts end at ended_at; an open one ends at its observation boundary, else it is still running.
  clauses.push(
    `(a.ended_at IS NOT NULL AND a.ended_at >= ?) OR (a.ended_at IS NULL AND (a.observation_ended_at IS NULL OR a.observation_ended_at >= ?))`,
  )
  params.push(from, since)
  if (taskId !== undefined) {
    clauses.push('a.task_id = ?')
    params.push(taskId)
  }
  if (agentId !== undefined) {
    clauses.push('a.profile = ?')
    params.push(agentId)
  }
  if (excludeCopies) clauses.push('a.copied_from IS NULL')
  const rows = sqlite
    .prepare(
      `SELECT a.*, h.state AS history_state FROM kanban_attempts a
       JOIN kanban_histories h ON h.id = a.history_id
       WHERE ${clauses.map((clause) => `(${clause})`).join(' AND ')}
       ORDER BY a.started_at, a.attempt_id, a.id`,
    )
    .all(...params)
  return rows.map(viewOf)
}

function viewOf(row: unknown): KanbanAttempt {
  const { history_state: historyState, ...rest } = row as Record<string, unknown>
  return attemptView(
    AttemptRowSchema.parse(rest),
    z.enum(['active', 'paused', 'closed']).parse(historyState),
  )
}

/** Attempts by opaque id (in the order asked, unknown ids skipped). */
export function attemptsByIds(sqlite: DatabaseSync, ids: readonly string[]): KanbanAttempt[] {
  const out: KanbanAttempt[] = []
  for (const id of ids) {
    const row = sqlite
      .prepare(
        `SELECT a.*, h.state AS history_state FROM kanban_attempts a
         JOIN kanban_histories h ON h.id = a.history_id WHERE a.id = ?`,
      )
      .get(id)
    if (row !== undefined) out.push(viewOf(row))
  }
  return out
}

/** The id of the live (active) history of the Kanban source, or null before one exists. Never inert-qualifies. */
export function activeHistoryId(sqlite: DatabaseSync): string | null {
  const row = sqlite.prepare("SELECT id FROM kanban_histories WHERE state = 'active' LIMIT 1").get()
  return row === undefined ? null : z.object({ id: z.string() }).parse(row).id
}

/**
 * A task reference qualified by the board lineage the attempt came from. Only `current` references may navigate to
 * /tasks/:id or allow actions; a task deleted upstream, or from a closed or unverified history, is historical.
 */
export function attemptSummary(attempt: KanbanAttempt): AttemptSummary {
  const startedAt = attempt.startedAt
  return {
    id: attempt.id,
    kind: 'kanban',
    agentId: attempt.agentId,
    role: attempt.role,
    status: attempt.status,
    closureReason: attempt.closureReason,
    startedAt,
    endedAt: attempt.endedAt,
    observationEndedAt: attempt.observationEndedAt,
    evidence: attempt.evidence,
    taskId: attempt.taskId,
    task: {
      taskId: attempt.taskId,
      historyId: attempt.historyId,
      current: attempt.historyState === 'active' && attempt.deletedUpstreamAt === null,
    },
    order: [startedAt, attempt.attemptId],
    refusedUpdates: attempt.refusedUpdates,
    tools: null,
    session: null,
    model: null,
  }
}

export function attemptDetail(attempt: KanbanAttempt): AttemptDetail {
  return { ...attemptSummary(attempt), taskSnapshot: attempt.taskSnapshot }
}

/** Sort key for every list of attempts: `(startedAt, upstream attempt id)`, never the opaque id. */
export function byAttemptOrder(
  a: { startedAt: string; attemptId: number },
  b: { startedAt: string; attemptId: number },
): number {
  return Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.attemptId - b.attemptId
}

export function attemptByKey(
  sqlite: DatabaseSync,
  historyId: string,
  attemptId: number,
): AttemptRow | undefined {
  const row = sqlite
    .prepare('SELECT * FROM kanban_attempts WHERE history_id = ? AND attempt_id = ?')
    .get(historyId, attemptId)
  return row === undefined ? undefined : AttemptRowSchema.parse(row)
}

/** One `attempt.updated` per changed attempt, built from the rows as committed in the same transaction. */
export function attemptUpdates(sqlite: DatabaseSync, ids: readonly string[]): DomainEventDraft[] {
  return attemptsByIds(sqlite, [...new Set(ids)]).map((attempt) => ({
    type: 'attempt.updated' as const,
    data: attemptSummary(attempt),
  }))
}

/**
 * The attempts of one task in the lineage Score follows now, oldest first by `(startedAt, upstream attempt id)`.
 * Attempts from an earlier copy of the board never join a task of the current one.
 */
export function currentAttemptsOfTask(
  sqlite: DatabaseSync,
  taskId: string,
  nowMs: number,
): KanbanAttempt[] {
  return listAttempts(sqlite, {
    since: new Date(0).toISOString(),
    until: new Date(nowMs).toISOString(),
    taskId,
    excludeCopies: true,
  }).filter((attempt) => attemptSummary(attempt).task.current)
}
