import type { DatabaseSync } from 'node:sqlite'
import type { AttemptDetail, AttemptSummary } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { HttpError } from '../errors.ts'

/** A run id that names a Kanban attempt (`kr_...`): never stoppable, answered before any profile lookup. */
export const KANBAN_ATTEMPT_STOP_MESSAGE =
  'Score can’t stop a single task run: Hermes has no stop for one run. Stop it in Hermes.'

export function assertNotKanbanAttempt(runId: string): void {
  if (runId.startsWith('kr_')) throw new HttpError(501, 'unsupported', KANBAN_ATTEMPT_STOP_MESSAGE)
}

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

export interface ObservationInterval {
  startedAt: string
  /** Null while still observed. */
  endedAt: string | null
}

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
  /**
   * Set while observation is stopped before the attempt ended (a boundary, never an end time); null while the attempt
   * is observed, including after observation resumed.
   */
  observationEndedAt: string | null
  /** Every stretch Score observed the attempt (a copied attempt includes its ancestors'), oldest first. */
  observations: ObservationInterval[]
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

/** The intervals of an attempt and of the earlier copies of it, merged where they overlap. */
export function observationsOf(
  sqlite: DatabaseSync,
  row: Pick<AttemptRow, 'id' | 'copied_from'>,
): ObservationInterval[] {
  const rows = z.array(z.object({ started_at: z.string(), ended_at: z.string().nullable() })).parse(
    sqlite
      .prepare(
        `SELECT o.started_at, o.ended_at FROM kanban_attempt_observations o
            WHERE o.attempt_id IN (SELECT id FROM kanban_attempts WHERE COALESCE(copied_from, id) = ?)
            ORDER BY o.started_at, o.seq`,
      )
      .all(row.copied_from ?? row.id),
  )
  const merged: ObservationInterval[] = []
  for (const interval of rows) {
    const last = merged.at(-1)
    if (last && (last.endedAt === null || interval.started_at <= last.endedAt)) {
      if (last.endedAt !== null && (interval.ended_at === null || interval.ended_at > last.endedAt))
        last.endedAt = interval.ended_at
    } else merged.push({ startedAt: interval.started_at, endedAt: interval.ended_at })
  }
  return merged
}

export function attemptView(
  row: AttemptRow,
  historyState: KanbanAttempt['historyState'],
  observed?: ObservationInterval[],
): KanbanAttempt {
  const snapshot = row.task_snapshot
    ? SnapshotSchema.safeParse(JSON.parse(row.task_snapshot))
    : undefined
  const endedAt = row.ended_at === null ? null : iso(row.ended_at)
  const last = observed?.at(-1)
  // Observation that resumed (or never stopped) has no boundary; one that stopped before the end keeps it.
  const boundary =
    last === undefined
      ? row.observation_ended_at
      : last.endedAt !== null && (endedAt === null || last.endedAt < endedAt)
        ? last.endedAt
        : null
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
    observationEndedAt: boundary,
    observations: observed ?? [],
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
  const to = Math.floor(Date.parse(until) / 1000)
  const clauses = ['a.started_at <= ?']
  const params: (string | number)[] = [to]
  // An attempt overlaps while one of its observed intervals does (an open interval runs to now).
  clauses.push(
    `EXISTS (SELECT 1 FROM kanban_attempt_observations o
              WHERE o.attempt_id IN (SELECT id FROM kanban_attempts WHERE COALESCE(copied_from, id) = COALESCE(a.copied_from, a.id))
                AND o.started_at <= ? AND (o.ended_at IS NULL OR o.ended_at >= ?))`,
  )
  // Interval times are Date#toISOString text: normalise the bounds the same way before comparing.
  params.push(new Date(until).toISOString(), new Date(since).toISOString())
  if (taskId !== undefined) {
    clauses.push('a.task_id = ?')
    params.push(taskId)
  }
  if (agentId !== undefined) {
    clauses.push('a.profile = ?')
    params.push(agentId)
  }
  // One representative per copied attempt: the newest row of the group carries the later observations and the
  // terminal update; the earlier rows' intervals are merged into it by observationsOf().
  if (excludeCopies)
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM kanban_attempts c
                    WHERE COALESCE(c.copied_from, c.id) = COALESCE(a.copied_from, a.id) AND c.id != a.id
                      AND (c.first_seen > a.first_seen OR (c.first_seen = a.first_seen AND c.rowid > a.rowid)))`,
    )
  const rows = sqlite
    .prepare(
      `SELECT a.*, h.state AS history_state FROM kanban_attempts a
       JOIN kanban_histories h ON h.id = a.history_id
       WHERE ${clauses.map((clause) => `(${clause})`).join(' AND ')}
       ORDER BY a.started_at, a.attempt_id, a.id`,
    )
    .all(...params)
  return rows.map((row) => viewOf(sqlite, row))
}

function viewOf(sqlite: DatabaseSync, row: unknown): KanbanAttempt {
  const { history_state: historyState, ...rest } = row as Record<string, unknown>
  const parsed = AttemptRowSchema.parse(rest)
  return attemptView(
    parsed,
    z.enum(['active', 'paused', 'closed']).parse(historyState),
    observationsOf(sqlite, parsed),
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
    if (row !== undefined) out.push(viewOf(sqlite, row))
  }
  return out
}

/** The id of the live (active) history of the Kanban source, or null before one exists. Never inert-qualifies. */
export function activeHistoryId(sqlite: DatabaseSync): string | null {
  const row = sqlite.prepare("SELECT id FROM kanban_histories WHERE state = 'active' LIMIT 1").get()
  return row === undefined ? null : z.object({ id: z.string() }).parse(row).id
}

/**
 * A task reference qualified by the board lineage the attempt came from. Only `current` references describe the board
 * Score follows now; a task deleted upstream, or from a closed or unverified history, is historical.
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
 * Attempts from an earlier copy of the board never join a task of the current one; a copy made by a restore is the
 * current lineage's own row, so it is included.
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
  }).filter((attempt) => attemptSummary(attempt).task.current)
}
