import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { AttemptRowSchema, type AttemptRow } from '../../../domain/kanban-attempts.ts'
import { classify, type StoredEvidence } from './classify.ts'
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
import type { Capture, HermesAttempt } from './types.ts'

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

export function observeAttempt(
  sqlite: DatabaseSync,
  capture: Capture,
  historyId: string,
  row: HermesAttempt,
  now: string,
  touched: Set<string>,
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
    // A copy (an attempt that survived a restore) matches on the whole frozen evidence: the same numeric id, task and
    // start second with a different claim lock, profile or process is a contradicting attempt, not a copy.
    const differs = (left: unknown, right: unknown) =>
      left !== null && right !== null && left !== right
    const copied = sqlite
      .prepare(
        `SELECT id, copied_from, claim_lock, profile, worker_pid, worker_started_at FROM kanban_attempts
          WHERE source_id = ? AND attempt_id = ? AND task_id = ? AND started_at = ? AND history_id != ?
          ORDER BY first_seen`,
      )
      .all(capture.sourceId, row.id, row.task_id, row.started_at, historyId)
      .map((candidate) =>
        z
          .object({
            id: z.string(),
            copied_from: z.string().nullable(),
            claim_lock: z.string().nullable(),
            profile: z.string().nullable(),
            worker_pid: z.int().nullable(),
            worker_started_at: z.string().nullable(),
          })
          .parse(candidate),
      )
      .find(
        (candidate) =>
          !differs(candidate.claim_lock, row.claim_lock) &&
          !differs(candidate.profile, row.profile) &&
          !differs(candidate.worker_pid, row.worker_pid) &&
          !differs(candidate.worker_started_at, fingerprintOf(row.worker_started_at)),
      )
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
    const newId = `kr_${randomUUID()}`
    touched.add(newId)
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
        newId,
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
        copied ? (copied.copied_from ?? copied.id) : null,
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
      touched.add(existing.id)
    }
    return
  }
  touched.add(existing.id)
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
