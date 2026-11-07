import type { DatabaseSync } from 'node:sqlite'
import { TRIGGER_LIMITS, TriggerMappingSchema, type JobSource } from '@score/contract'
import type { Sealer } from '../../auth/sealing.ts'
import { HttpError } from '../../errors.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { redact } from '../../redact.ts'
import { teamRoomId } from '../team-room.ts'
import { takeCall } from './queue.ts'
import { renderOpening, safeLink, sampleOf, valueAt } from './trigger-content.ts'
import { context, row, type Row } from './trigger-rows.ts'
import { verifyWebhook } from './signature.ts'

// Trigger call intake: signature checks, idempotency, budgets, the job source and handing the call to the team queue.

/** The team room a call starts its job in: the trigger's own team, else (gone or archived) the first team room. */
function teamOf(sqlite: DatabaseSync, trigger: Row): string | null {
  if (
    trigger.team_room_id &&
    sqlite
      .prepare("SELECT 1 FROM rooms WHERE id = ? AND role = 'team' AND archived = 0")
      .get(trigger.team_room_id)
  )
    return trigger.team_room_id
  return teamRoomId(sqlite)
}

export type CallResult =
  /** `jobId` null: the person skipped this call while it waited (3.28.0). */
  | { status: 200; jobId: string | null; repeated: boolean }
  /** 3.28.0: the team room had a job running; the call waits in its queue (Next up). */
  | { status: 202; queueId: string; repeated: boolean }

/** Checks a call before anything is queued: the trigger exists and the signature is valid now. Throws the answer. */
export function verifyCall(
  sqlite: DatabaseSync,
  seal: Sealer,
  id: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  raw: string,
  nowMs: number,
): Row {
  const trigger = row(sqlite, id)
  if (!trigger) throw new HttpError(404, 'not_found', 'No such trigger.')
  if (trigger.deleted_at) throw new HttpError(410, 'gone', 'This trigger was deleted.')
  if (headers.id !== undefined && (headers.id.length > 128 || !/^[\x21-\x7e]+$/.test(headers.id)))
    throw new HttpError(
      401,
      'missing_headers',
      'The webhook-id must be 1–128 printable characters.',
    )
  const secret = seal.unseal(trigger.secret_sealed, context(id))
  if (!secret) throw new HttpError(401, 'bad_signature', 'The signature could not be checked.')
  const check = verifyWebhook(secret, headers, raw, Math.floor(nowMs / 1000))
  if (!check.ok)
    throw new HttpError(401, check.reason, 'The webhook signature is missing, stale or wrong.')
  return trigger
}

/**
 * A call to `POST /hooks/<id>`. The route has checked the size and read the raw body; this checks the signature,
 * remembers the call id, and starts the job. Throws the HTTP error to answer otherwise.
 */
export function receiveCall(
  sqlite: DatabaseSync,
  seal: Sealer,
  id: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  raw: string,
  nowMs: number,
): { result: CallResult; drafts: DomainEventDraft[] } {
  const trigger = verifyCall(sqlite, seal, id, headers, raw, nowMs)
  const now = new Date(nowMs).toISOString()
  // Forget calls older than the idempotency window, then answer a repeat with the job it started.
  sqlite
    .prepare('DELETE FROM trigger_calls WHERE received_at < ?')
    .run(new Date(nowMs - TRIGGER_LIMITS.idempotencyHours * 3600_000).toISOString())
  const seen = sqlite
    .prepare('SELECT job_id FROM trigger_calls WHERE trigger_id = ? AND webhook_id = ?')
    .get(id, headers.id!) as { job_id: string | null } | undefined
  if (seen?.job_id)
    return { result: { status: 200, jobId: seen.job_id, repeated: true }, drafts: [] }
  // 3.28.0: a call the person skipped from the queue is answered, and starts nothing.
  if (seen) return { result: { status: 200, jobId: null, repeated: true }, drafts: [] }
  const waiting = sqlite
    .prepare('SELECT id FROM room_queue WHERE trigger_id = ? AND webhook_id = ?')
    .get(id, headers.id!) as { id: string } | undefined
  if (waiting) return { result: { status: 202, queueId: waiting.id, repeated: true }, drafts: [] }
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new HttpError(415, 'not_json', 'The body must be JSON.')
  }
  const team = teamOf(sqlite, trigger)
  if (!team) throw new HttpError(503, 'not_ready', 'Score has no team room yet.')
  // Each call starts a job and a lead turn: bound how many a trigger can have open and start in a day (decision 121).
  const ofTrigger = "json_extract(source, '$.triggerId') = ?"
  const open = sqlite
    .prepare(
      `SELECT count(*) AS n FROM jobs WHERE ${ofTrigger} AND state NOT IN ('done', 'closed') AND deleted_at IS NULL`,
    )
    .get(id) as { n: number }
  // Calls waiting in the queue count as open jobs (3.28.0), so a busy team room can't collect an endless queue.
  const queued = sqlite
    .prepare('SELECT count(*) AS n FROM room_queue WHERE trigger_id = ?')
    .get(id) as { n: number }
  if (open.n + queued.n >= TRIGGER_LIMITS.openJobs)
    throw new HttpError(
      429,
      'trigger_busy',
      `This trigger already has ${TRIGGER_LIMITS.openJobs} open jobs. Finish or close some, then call again.`,
    )
  const dayAgo = new Date(nowMs - 24 * 3600_000).toISOString()
  const today = sqlite
    .prepare(
      `SELECT (SELECT count(*) FROM jobs WHERE json_extract(source, '$.triggerId') = ?1 AND created_at > ?2)
            + (SELECT count(*) FROM room_queue WHERE trigger_id = ?1 AND created_at > ?2) AS n`,
    )
    .get(id, dayAgo) as { n: number }
  if (today.n >= TRIGGER_LIMITS.jobsPerDay)
    throw new HttpError(
      429,
      'trigger_busy',
      `This trigger started ${TRIGGER_LIMITS.jobsPerDay} jobs in the last day. Call again later.`,
    )
  const mapping = TriggerMappingSchema.parse(JSON.parse(trigger.mapping))
  const opening = renderOpening(trigger.app, trigger.template, mapping, payload)
  const ref = valueAt(payload, mapping.ref)
  const title = mapping.title ? valueAt(payload, mapping.title) : null
  const source: JobSource = {
    app: trigger.app,
    ref: redact(ref ?? '(no reference)').slice(0, 200),
    title: title === null ? null : redact(title).slice(0, 200),
    link: mapping.link ? safeLink(valueAt(payload, mapping.link)) : null,
    triggerId: id,
    missing: opening.missing,
  }
  const jobTitle = [source.ref, source.title].filter(Boolean).join(' · ').slice(0, 200)
  // The redacted payload is the trigger's sample for building its mapping.
  sqlite
    .prepare('UPDATE triggers SET sample = ?, last_called_at = ? WHERE id = ?')
    .run(sampleOf(payload), now, id)
  const call = {
    team,
    triggerId: id,
    webhookId: headers.id!,
    title: jobTitle,
    source,
    opening: opening.text,
  }
  // 3.28.0 (decision 164): the team room runs one job at a time. A call while one runs, or while older calls still
  // wait, goes to the back of the queue (Next up); a free room starts its oldest waiting call.
  const outcome = takeCall(sqlite, call, now)
  return outcome.started
    ? { result: { status: 200, jobId: outcome.jobId, repeated: false }, drafts: outcome.drafts }
    : { result: { status: 202, queueId: outcome.queueId, repeated: false }, drafts: outcome.drafts }
}
