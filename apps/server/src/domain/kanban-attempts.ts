import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

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
}

/**
 * Attempts overlapping [since, until], oldest first by (startedAt, upstream attempt id) -- never by the opaque id.
 * An open attempt overlaps up to its observation boundary, or `until` while it is still observed.
 */
export function listAttempts(sqlite: DatabaseSync, input: ListAttemptsInput): KanbanAttempt[] {
  const { since, until, taskId, agentId } = z
    .object({
      since: z.iso.datetime(),
      until: z.iso.datetime(),
      taskId: z.string().min(1).optional(),
      agentId: z.string().min(1).optional(),
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
  const rows = sqlite
    .prepare(
      `SELECT a.*, h.state AS history_state FROM kanban_attempts a
       JOIN kanban_histories h ON h.id = a.history_id
       WHERE ${clauses.map((clause) => `(${clause})`).join(' AND ')}
       ORDER BY a.started_at, a.attempt_id, a.id`,
    )
    .all(...params)
  return rows.map((row) => {
    const { history_state: historyState, ...rest } = row as Record<string, unknown>
    return attemptView(
      AttemptRowSchema.parse(rest),
      z.enum(['active', 'paused', 'closed']).parse(historyState),
    )
  })
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
