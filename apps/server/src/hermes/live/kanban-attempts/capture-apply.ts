import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { AttemptRowSchema } from '../../../domain/kanban-attempts.ts'
import { observeAttempt } from './attempt-observer.ts'
import { judgeHistory, type KnownAttempt, type Verdict } from './history-policy.ts'
import {
  closeHistory,
  openHistory,
  pauseHistory,
  readHistory,
  resumeHistory,
} from './history-store.ts'
import { recordPage, type PageOutcome } from './page-store.ts'
import type { Capture } from './types.ts'

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

/** Test seams for crash points inside the writer transaction. */
export interface WriterFaults {
  afterRows?: () => void
}

export interface ApplyResult {
  /** Opaque ids of every attempt this page created or changed (the caller turns them into attempt.updated). */
  touched: string[]
  outcome: PageOutcome
  /** Set when a contradiction opened a new history. */
  newHistoryId?: string
  verdict?: Verdict
}

function markDeleted(
  sqlite: DatabaseSync,
  historyId: string,
  attemptId: number,
  now: string,
  touched: Set<string>,
): void {
  const raw = sqlite
    .prepare('SELECT * FROM kanban_attempts WHERE history_id = ? AND attempt_id = ?')
    .get(historyId, attemptId)
  if (raw === undefined) return
  const row = AttemptRowSchema.parse(raw)
  if (row.deleted_upstream_at !== null) return
  touched.add(row.id)
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
  if (already) return { outcome: 'applied', touched: [] }
  const history = readHistory(sqlite, capture.historyId)
  if (!history || history.state === 'closed') {
    // The history was replaced while this page waited: its rows describe a lineage Score no longer follows.
    if (history) recordPage(sqlite, capture, history.id, 'stale')
    return { outcome: 'stale', touched: [] }
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
  const touched = new Set<string>()
  if (verdict.verdict === 'contradiction') {
    for (const id of closeHistory(sqlite, history.id, verdict.reason, now)) touched.add(id)
    // Projections of tasks stop belonging to a lineage that was replaced; the live task poll restamps the ones the new
    // board still has. Every other association keeps the old stamp and is inert from here on.
    sqlite
      .prepare('UPDATE task_projections SET history_id = NULL WHERE history_id = ?')
      .run(history.id)
    const newHistoryId = capture.marks
      ? openHistory(sqlite, {
          sourceId: history.source_id,
          marks: capture.marks,
          fileIdentity: capture.fileIdentity,
          now,
        })
      : undefined
    recordPage(sqlite, capture, history.id, 'contradiction')
    return {
      outcome: 'contradiction',
      touched: [...touched],
      verdict,
      ...(newHistoryId ? { newHistoryId } : {}),
    }
  }
  if (verdict.verdict === 'insufficient') {
    for (const id of pauseHistory(sqlite, history.id, verdict.reason, now) ?? []) touched.add(id)
    recordPage(sqlite, capture, history.id, 'paused')
    return { outcome: 'paused', touched: [...touched], verdict }
  }
  if (history.state === 'paused')
    for (const id of resumeHistory(sqlite, history.id, now)) touched.add(id)

  for (const row of capture.attempts) observeAttempt(sqlite, capture, history.id, row, now, touched)

  const returned = new Set(capture.attempts.map((attempt) => attempt.id))
  // A malformed row hides its id: skip disappearance decisions rather than guess.
  if (capture.malformed === 0) {
    if (capture.kind === 'sweep') {
      for (const id of capture.requestedIds)
        if (!returned.has(id)) markDeleted(sqlite, history.id, id, now, touched)
    } else if (capture.range) {
      for (const id of knownIdsInRange(sqlite, history.id, capture.range.from, capture.range.to))
        if (!returned.has(id)) markDeleted(sqlite, history.id, id, now, touched)
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
  return { outcome: 'applied', touched: [...touched], verdict }
}
