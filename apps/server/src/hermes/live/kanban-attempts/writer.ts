import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { AttemptRowSchema, type AttemptRow } from '../../../domain/kanban-attempts.ts'
import { classify, type StoredEvidence } from './classify.ts'
import { effectiveMark, judgeHistory, type KnownAttempt, type Verdict } from './history-policy.ts'
import {
  ERROR_BYTES,
  SUMMARY_BYTES,
  attemptStatus,
  boundedText,
  claimEventFor,
  fingerprintOf,
  hashContent,
  isTerminal,
  taskSnapshot,
} from './project.ts'
import type { Capture, HermesAttempt, Marks } from './types.ts'

export const HistoryRowSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  opened_at: z.string(),
  closed_at: z.string().nullable(),
  state: z.enum(['active', 'paused', 'closed']),
  reason: z.string().nullable(),
  event_alloc_mark: z.int(),
  attempt_alloc_mark: z.int(),
  event_cursor: z.int(),
  baseline_cursor: z.int(),
  baseline_done: z.int(),
  fullpass_cursor: z.int(),
  file_identity: z.string().nullable(),
})
export type HistoryRow = z.infer<typeof HistoryRowSchema>

/** Test seams for crash points inside the writer transaction. */
export interface WriterFaults {
  afterRows?: () => void
}

export type PageOutcome = 'applied' | 'stale' | 'paused' | 'contradiction'

export function liveHistory(sqlite: DatabaseSync, sourceId: string): HistoryRow | undefined {
  const row = sqlite
    .prepare("SELECT * FROM kanban_histories WHERE source_id = ? AND state != 'closed'")
    .get(sourceId)
  return row === undefined ? undefined : HistoryRowSchema.parse(row)
}

function readHistory(sqlite: DatabaseSync, id: string): HistoryRow | undefined {
  const row = sqlite.prepare('SELECT * FROM kanban_histories WHERE id = ?').get(id)
  return row === undefined ? undefined : HistoryRowSchema.parse(row)
}

export function ensureSource(
  sqlite: DatabaseSync,
  source: { id: string; path: string; board: string },
  now: string,
): void {
  sqlite
    .prepare(
      'INSERT INTO kanban_sources (id, path, board, first_seen) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
    )
    .run(source.id, source.path, source.board, now)
}

/** Marks to save when a history opens: the allocation marks and the end of the events already behind it. */
function openingMarks(
  marks: Marks,
): { event: number; attempt: number; cursor: number } | undefined {
  const events = effectiveMark('task_events', marks.eventSeq, marks.eventMin, marks.eventMax)
  const runs = effectiveMark('task_runs', marks.runSeq, marks.runMin, marks.runMax)
  if ('insufficient' in events || 'insufficient' in runs) return undefined
  // Events before the opening are covered by the baseline of attempts; the tail starts at the current end.
  return { event: events.mark, attempt: runs.mark, cursor: marks.eventMax ?? 0 }
}

export function openHistory(
  sqlite: DatabaseSync,
  input: { sourceId: string; marks: Marks; fileIdentity: string; now: string; newId?: string },
): string | undefined {
  const opening = openingMarks(input.marks)
  if (!opening) return undefined
  const id = input.newId ?? `kh_${randomUUID()}`
  sqlite
    .prepare(
      `INSERT INTO kanban_histories
         (id, source_id, opened_at, state, event_alloc_mark, attempt_alloc_mark, event_cursor, file_identity)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.sourceId,
      input.now,
      opening.event,
      opening.attempt,
      opening.cursor,
      input.fileIdentity,
    )
  return id
}

/** Observation stops for every open attempt that was under observation: a boundary, never an end time. */
function endObservation(sqlite: DatabaseSync, historyId: string, now: string): void {
  sqlite
    .prepare(
      `UPDATE kanban_attempts
          SET observing = 0, observation_ended_at = ?, observation_gaps = observation_gaps + 1
        WHERE history_id = ? AND ended_at IS NULL AND observing = 1`,
    )
    .run(now, historyId)
}

export function pauseHistory(
  sqlite: DatabaseSync,
  historyId: string,
  reason: string,
  now: string,
): boolean {
  const history = readHistory(sqlite, historyId)
  if (!history || history.state === 'closed') return false
  endObservation(sqlite, historyId, now)
  sqlite
    .prepare("UPDATE kanban_histories SET state = 'paused', reason = ? WHERE id = ?")
    .run(reason.slice(0, 300), historyId)
  return true
}

function closeHistory(sqlite: DatabaseSync, historyId: string, reason: string, now: string): void {
  endObservation(sqlite, historyId, now)
  sqlite
    .prepare("UPDATE kanban_histories SET state = 'closed', closed_at = ?, reason = ? WHERE id = ?")
    .run(now, reason.slice(0, 300), historyId)
}

function resumeHistory(sqlite: DatabaseSync, historyId: string, now: string): void {
  sqlite
    .prepare("UPDATE kanban_histories SET state = 'active', reason = NULL WHERE id = ?")
    .run(historyId)
  // The boundary stays as recorded history; observation continues from here with the gap retained.
  sqlite
    .prepare(
      `UPDATE kanban_attempts SET observing = 1, observation_resumed_at = ?
        WHERE history_id = ? AND ended_at IS NULL AND observing = 0 AND deleted_upstream_at IS NULL`,
    )
    .run(now, historyId)
}

function knownAttempts(
  sqlite: DatabaseSync,
  historyId: string,
  ids: readonly number[],
): Map<number, KnownAttempt> {
  const out = new Map<number, KnownAttempt>()
  const unique = [...new Set(ids)]
  for (let offset = 0; offset < unique.length; offset += 200) {
    const chunk = unique.slice(offset, offset + 200)
    const rows = sqlite
      .prepare(
        `SELECT * FROM kanban_attempts WHERE history_id = ? AND attempt_id IN (${chunk.map(() => '?').join(', ')})`,
      )
      .all(historyId, ...chunk)
    for (const raw of rows) {
      const row = AttemptRowSchema.parse(raw)
      out.set(row.attempt_id, {
        attemptId: row.attempt_id,
        taskId: row.task_id,
        startedAt: row.started_at,
        closed: row.ended_at !== null,
        claimLock: row.claim_lock,
        profile: row.profile,
        workerPid: row.worker_pid,
        workerStartedAt: row.worker_started_at,
      })
    }
  }
  return out
}

function recordPage(
  sqlite: DatabaseSync,
  capture: Capture,
  historyId: string,
  outcome: PageOutcome,
): void {
  const ids = capture.attempts.map((attempt) => attempt.id)
  const from = capture.range ? capture.range.from : ids.length ? Math.min(...ids) : null
  const to = capture.range ? capture.range.to : ids.length ? Math.max(...ids) : null
  sqlite
    .prepare(
      `INSERT INTO kanban_pages
         (capture_id, kind, history_id, event_from, event_to, attempt_from, attempt_to, captured_at, outcome, malformed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      capture.captureId,
      capture.kind,
      historyId,
      capture.eventFrom,
      capture.eventTo,
      from,
      to,
      capture.capturedAt,
      outcome,
      capture.malformed,
    )
}

function storedEvidence(row: AttemptRow): StoredEvidence {
  return {
    evidence: row.evidence,
    firstSeenOpen: row.first_seen_open === 1,
    claimLock: row.claim_lock,
    claimEventId: row.claim_event_id,
    workerPid: row.worker_pid,
    workerStartedAt: row.worker_started_at,
  }
}

function observeAttempt(
  sqlite: DatabaseSync,
  capture: Capture,
  historyId: string,
  row: HermesAttempt,
  now: string,
): void {
  const existingRaw = sqlite
    .prepare('SELECT * FROM kanban_attempts WHERE history_id = ? AND attempt_id = ?')
    .get(historyId, row.id)
  const existing = existingRaw === undefined ? undefined : AttemptRowSchema.parse(existingRaw)
  const taskEvents = capture.evidenceEvents.filter((event) => event.task_id === row.task_id)
  const task = capture.tasks.find((candidate) => candidate.id === row.task_id)
  const claim = claimEventFor(taskEvents, row.id)
  const { status, closureReason } = attemptStatus(row)
  const classification = classify({
    row,
    stored: existing ? storedEvidence(existing) : null,
    events: taskEvents,
    eventsTruncated: capture.evidenceTruncated,
    task,
  })
  const snapshot = taskSnapshot(task)

  if (!existing) {
    if (classification.evidence === 'synthetic') return
    const copied = sqlite
      .prepare(
        `SELECT id FROM kanban_attempts
          WHERE source_id = ? AND attempt_id = ? AND task_id = ? AND started_at = ? AND history_id != ?
          ORDER BY first_seen LIMIT 1`,
      )
      .get(capture.sourceId, row.id, row.task_id, row.started_at, historyId)
    const role = claim ? (claim.sourceStatus === 'review' ? 'reviewer' : 'implementer') : null
    const content = {
      profile: row.profile,
      role,
      status,
      closureReason,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      evidence: classification.evidence,
      claimLock: row.claim_lock,
      claimEventId: claim?.eventId ?? null,
      claimSourceStatus: claim?.sourceStatus ?? null,
      workerPid: row.worker_pid,
      workerStartedAt: fingerprintOf(row.worker_started_at),
      summary: boundedText(row.summary, SUMMARY_BYTES),
      error: boundedText(row.error, ERROR_BYTES),
    }
    const open = row.ended_at === null
    sqlite
      .prepare(
        `INSERT INTO kanban_attempts
           (id, source_id, history_id, attempt_id, task_id, profile, role, status, closure_reason, started_at,
            ended_at, first_seen_open, evidence, classification_basis, claim_lock, claim_event_id,
            claim_source_status, worker_pid, worker_started_at, summary, error, task_snapshot, revision,
            content_hash, copied_from, first_seen, last_observed_at, observing)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        `kr_${randomUUID()}`,
        capture.sourceId,
        historyId,
        row.id,
        row.task_id,
        content.profile,
        content.role,
        content.status,
        content.closureReason,
        content.startedAt,
        content.endedAt,
        open ? 1 : 0,
        content.evidence,
        classification.basis,
        content.claimLock,
        content.claimEventId,
        content.claimSourceStatus,
        content.workerPid,
        content.workerStartedAt,
        content.summary,
        content.error,
        snapshot,
        hashContent(content),
        copied ? z.object({ id: z.string() }).parse(copied).id : null,
        now,
        now,
        open ? 1 : 0,
      )
    return
  }

  // An existing attempt: frozen evidence only ever fills in, never clears.
  const merged = {
    profile: existing.profile ?? row.profile,
    role:
      existing.role ??
      (claim ? (claim.sourceStatus === 'review' ? 'reviewer' : 'implementer') : null),
    claimLock: existing.claim_lock ?? row.claim_lock,
    claimEventId: existing.claim_event_id ?? claim?.eventId ?? null,
    claimSourceStatus: existing.claim_source_status ?? claim?.sourceStatus ?? null,
    workerPid: existing.worker_pid ?? row.worker_pid,
    workerStartedAt: existing.worker_started_at ?? fingerprintOf(row.worker_started_at),
  }
  // A row ever seen open is never reclassified synthetic; evidence only moves partial -> proven.
  const evidence =
    existing.evidence === 'proven' || classification.evidence === 'proven' ? 'proven' : 'partial'
  const basis =
    existing.evidence === 'partial' && evidence === 'proven'
      ? classification.basis
      : existing.classification_basis

  let next: { status: AttemptRow['status']; closureReason: string | null; endedAt: number | null } =
    {
      status,
      closureReason,
      endedAt: row.ended_at,
    }
  let refused = 0
  let refusedHash = existing.refused_hash
  const wasTerminal = isTerminal(existing.status)
  if (wasTerminal) {
    // Newer content of the same terminal, or ended_unknown refined to a known terminal, is accepted. A different
    // known terminal, or terminal -> open (a contradiction judged before this point), keeps what Score has.
    const accepted =
      isTerminal(status) && (status === existing.status || existing.status === 'ended_unknown')
    if (!accepted) {
      const incoming = hashContent({
        status,
        closureReason,
        endedAt: row.ended_at,
        summary: row.summary,
        error: row.error,
      })
      // The same conflicting content seen again is not a new refusal.
      if (incoming === existing.refused_hash) return
      refusedHash = incoming
      refused = 1
      next = {
        status: existing.status,
        closureReason: existing.closure_reason,
        endedAt: existing.ended_at,
      }
    }
  }
  const refreshContent = refused === 0
  const content = {
    profile: merged.profile,
    role: merged.role,
    status: next.status,
    closureReason: next.closureReason,
    startedAt: existing.started_at,
    endedAt: next.endedAt,
    evidence,
    claimLock: merged.claimLock,
    claimEventId: merged.claimEventId,
    claimSourceStatus: merged.claimSourceStatus,
    workerPid: merged.workerPid,
    workerStartedAt: merged.workerStartedAt,
    summary: refreshContent ? boundedText(row.summary, SUMMARY_BYTES) : existing.summary,
    error: refreshContent ? boundedText(row.error, ERROR_BYTES) : existing.error,
  }
  const hash = hashContent(content)
  const closing = next.status !== 'running'
  const reappeared = existing.deleted_upstream_at !== null
  const needsObservation = !closing && (reappeared || existing.observing === 0)
  const snapshotChanged = snapshot !== null && snapshot !== existing.task_snapshot
  if (
    hash === existing.content_hash &&
    refused === 0 &&
    !reappeared &&
    !snapshotChanged &&
    !(closing && existing.observing === 1)
  ) {
    if (needsObservation) {
      // Observed open again after a boundary: continue with the gap retained.
      sqlite
        .prepare(
          'UPDATE kanban_attempts SET observing = 1, observation_resumed_at = ? WHERE id = ?',
        )
        .run(now, existing.id)
    }
    return
  }
  const changed = hash !== existing.content_hash
  sqlite
    .prepare(
      `UPDATE kanban_attempts SET
         profile = ?, role = ?, status = ?, closure_reason = ?, ended_at = ?, evidence = ?, classification_basis = ?,
         claim_lock = ?, claim_event_id = ?, claim_source_status = ?, worker_pid = ?, worker_started_at = ?,
         summary = ?, error = ?, task_snapshot = COALESCE(?, task_snapshot), revision = ?, content_hash = ?,
         last_observed_at = ?, deleted_upstream_at = NULL, refused_updates = refused_updates + ?, refused_hash = ?,
         observing = ?, observation_resumed_at = CASE WHEN ? = 1 THEN ? ELSE observation_resumed_at END
       WHERE id = ?`,
    )
    .run(
      content.profile,
      content.role,
      content.status,
      content.closureReason,
      content.endedAt,
      content.evidence,
      basis,
      content.claimLock,
      content.claimEventId,
      content.claimSourceStatus,
      content.workerPid,
      content.workerStartedAt,
      content.summary,
      content.error,
      snapshot,
      existing.revision + (changed ? 1 : 0),
      hash,
      now,
      refused,
      refusedHash,
      closing ? 0 : 1,
      needsObservation ? 1 : 0,
      now,
      existing.id,
    )
}

function markDeleted(
  sqlite: DatabaseSync,
  historyId: string,
  attemptId: number,
  now: string,
): void {
  const raw = sqlite
    .prepare('SELECT * FROM kanban_attempts WHERE history_id = ? AND attempt_id = ?')
    .get(historyId, attemptId)
  if (raw === undefined) return
  const row = AttemptRowSchema.parse(raw)
  if (row.deleted_upstream_at !== null) return
  // An open attempt that vanished (task deleted or archived upstream) has no end time: only a boundary.
  const boundary = row.ended_at === null && row.observing === 1
  sqlite
    .prepare(
      `UPDATE kanban_attempts SET deleted_upstream_at = ?,
         observing = CASE WHEN ? = 1 THEN 0 ELSE observing END,
         observation_ended_at = CASE WHEN ? = 1 THEN ? ELSE observation_ended_at END,
         observation_gaps = observation_gaps + ?
       WHERE id = ?`,
    )
    .run(now, boundary ? 1 : 0, boundary ? 1 : 0, now, boundary ? 1 : 0, row.id)
}

function knownIdsInRange(
  sqlite: DatabaseSync,
  historyId: string,
  from: number,
  to: number | null,
): number[] {
  const rows =
    to === null
      ? sqlite
          .prepare(
            'SELECT attempt_id FROM kanban_attempts WHERE history_id = ? AND attempt_id > ? ORDER BY attempt_id',
          )
          .all(historyId, from)
      : sqlite
          .prepare(
            'SELECT attempt_id FROM kanban_attempts WHERE history_id = ? AND attempt_id > ? AND attempt_id <= ? ORDER BY attempt_id',
          )
          .all(historyId, from, to)
  return z
    .array(z.object({ attempt_id: z.int() }))
    .parse(rows)
    .map((row) => row.attempt_id)
}

export interface ApplyResult {
  outcome: PageOutcome
  /** Set when a contradiction opened a new history. */
  newHistoryId?: string
  verdict?: Verdict
}

/**
 * The page transaction (runs inside the ingest observation): judge the history, then either close/pause it or apply
 * the rows, advance marks and cursors, and record the capture id -- all or nothing.
 */
export function applyCapture(
  sqlite: DatabaseSync,
  capture: Capture,
  now: string,
  faults: WriterFaults = {},
): ApplyResult {
  if (!sqlite.isTransaction) throw new Error('Kanban pages require a transaction')
  const already = sqlite
    .prepare('SELECT 1 FROM kanban_pages WHERE capture_id = ?')
    .get(capture.captureId)
  if (already) return { outcome: 'applied' }
  const history = readHistory(sqlite, capture.historyId)
  if (!history || history.state === 'closed') {
    // The history was replaced while this page waited: its rows describe a lineage Score no longer follows.
    if (history) recordPage(sqlite, capture, history.id, 'stale')
    return { outcome: 'stale' }
  }
  const known = knownAttempts(sqlite, history.id, [
    ...capture.attempts.map((attempt) => attempt.id),
    ...capture.sample.map((attempt) => attempt.id),
  ])
  const identityChanged =
    history.file_identity !== null && history.file_identity !== capture.fileIdentity
  const knownCount = identityChanged
    ? z
        .object({ n: z.int() })
        .parse(
          sqlite
            .prepare('SELECT COUNT(*) AS n FROM kanban_attempts WHERE history_id = ?')
            .get(history.id),
        ).n
    : 0
  const verdict = judgeHistory({
    saved: {
      eventMark: history.event_alloc_mark,
      attemptMark: history.attempt_alloc_mark,
      fileIdentity: history.file_identity,
    },
    observedIdentity: capture.fileIdentity,
    marks: capture.marks,
    rows: capture.attempts,
    sample: capture.sample,
    known,
    knownCount,
    sampleIds: capture.sampleIds,
  })
  if (verdict.verdict === 'contradiction') {
    closeHistory(sqlite, history.id, verdict.reason, now)
    const newHistoryId = capture.marks
      ? openHistory(sqlite, {
          sourceId: history.source_id,
          marks: capture.marks,
          fileIdentity: capture.fileIdentity,
          now,
        })
      : undefined
    recordPage(sqlite, capture, history.id, 'contradiction')
    return { outcome: 'contradiction', verdict, ...(newHistoryId ? { newHistoryId } : {}) }
  }
  if (verdict.verdict === 'insufficient') {
    pauseHistory(sqlite, history.id, verdict.reason, now)
    recordPage(sqlite, capture, history.id, 'paused')
    return { outcome: 'paused', verdict }
  }
  if (history.state === 'paused') resumeHistory(sqlite, history.id, now)

  for (const row of capture.attempts) observeAttempt(sqlite, capture, history.id, row, now)

  const returned = new Set(capture.attempts.map((attempt) => attempt.id))
  // A malformed row hides its id: skip disappearance decisions rather than guess.
  if (capture.malformed === 0) {
    if (capture.kind === 'sweep') {
      for (const id of capture.requestedIds)
        if (!returned.has(id)) markDeleted(sqlite, history.id, id, now)
    } else if (capture.range) {
      for (const id of knownIdsInRange(sqlite, history.id, capture.range.from, capture.range.to))
        if (!returned.has(id)) markDeleted(sqlite, history.id, id, now)
    }
  }

  let eventCursor = history.event_cursor
  if (capture.kind === 'tail') {
    const seen = sqlite.prepare(
      'INSERT INTO kanban_seen_events (history_id, event_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
    )
    for (const event of capture.events) seen.run(history.id, event.id)
    if (capture.eventScanned !== null) eventCursor = Math.max(eventCursor, capture.eventScanned)
  }
  let baselineCursor = history.baseline_cursor
  let baselineDone = history.baseline_done
  let fullpassCursor = history.fullpass_cursor
  if (capture.range && capture.kind === 'baseline') {
    baselineCursor = capture.range.to ?? Math.max(baselineCursor, capture.range.from)
    if (capture.range.to === null) baselineDone = 1
  } else if (capture.range && capture.kind === 'fullpass') {
    // The cycle wraps to the start after the last page.
    fullpassCursor = capture.range.to ?? 0
  }
  sqlite
    .prepare(
      `UPDATE kanban_histories SET
         event_alloc_mark = ?, attempt_alloc_mark = ?, event_cursor = ?, baseline_cursor = ?, baseline_done = ?,
         fullpass_cursor = ?, file_identity = ?
       WHERE id = ?`,
    )
    .run(
      Math.max(history.event_alloc_mark, verdict.eventMark),
      Math.max(history.attempt_alloc_mark, verdict.attemptMark),
      eventCursor,
      baselineCursor,
      baselineDone,
      fullpassCursor,
      capture.fileIdentity,
      history.id,
    )
  faults.afterRows?.()
  recordPage(sqlite, capture, history.id, 'applied')
  return { outcome: 'applied', verdict }
}
