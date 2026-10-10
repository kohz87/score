import type {
  AbandonDecision,
  GateDecision,
  InquiryAnswer,
  LimitsDecision,
  RunControl,
  WaiverDecision,
} from '@score/contract'
import { HttpError } from '../../errors.ts'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import {
  addStored,
  cascadeBlocked,
  oweStop,
  refuseAttempt,
  retireQueued,
  setStepStatus,
  utf8Bytes,
  withdrawGates,
  withdrawInquiries,
} from './ops.ts'
import {
  addCause,
  addHistory,
  attemptsOf,
  isTerminalStatus,
  readGate,
  requireOrch,
  stepsOf,
  inquiriesOf,
  type OrchRow,
} from './store.ts'
import { cancelFenceAttempts } from './views.ts'

// Human decisions (contract §14). Each is revision-bound: the page names the run revision it showed, and a stale one is
// a 409. Stop is the exception: it can only reduce risk, so it never waits on a stale page.

function expectRevision(o: OrchRow, revision: number): void {
  if (o.revision !== revision)
    throw new HttpError(
      409,
      'conflict',
      'This run changed since you looked; reload and try again',
      {
        currentRevision: o.revision,
      },
    )
}

const mustBeLive = (o: OrchRow): void => {
  if (isTerminalStatus(o.status) || o.status === 'stopping' || o.status === 'finishing')
    throw new HttpError(409, 'conflict', `The run is ${o.status}`)
}

export function decideGate(ctx: Ctx, orchId: string, gateId: string, body: GateDecision): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const gate = readGate(sqlite, orchId, gateId)
  if (!gate) throw new HttpError(404, 'not_found', 'Unknown gate')
  if (gate.status !== 'open' || gate.revision !== body.expectedRevision)
    throw new HttpError(409, 'conflict', 'This gate was already decided or changed', {
      currentRevision: gate.revision,
    })
  const approve = body.decision === 'approve'
  sqlite
    .prepare(
      `UPDATE orc_gates SET status = ?, revision = revision + 1, note = ?, decided_at = ? WHERE orchestration_id = ? AND id = ?`,
    )
    .run(approve ? 'approved' : 'rejected', body.note ?? null, now, orchId, gateId)
  if (approve) setStepStatus(sqlite, orchId, gate.step_id, 'queued', null, now)
  else {
    setStepStatus(
      sqlite,
      orchId,
      gate.step_id,
      'rejected',
      body.note ? `rejected: ${body.note}` : 'rejected by the person',
      now,
    )
    sqlite
      .prepare('UPDATE orc_steps SET retired = 1 WHERE orchestration_id = ? AND id = ?')
      .run(orchId, gate.step_id)
    addCause(sqlite, orchId, 'gate_rejected', gate.step_id, now, body.note ?? null)
    cascadeBlocked(sqlite, orchId, now)
  }
  addHistory(
    sqlite,
    orchId,
    approve ? 'gate_approved' : 'gate_rejected',
    { gateId, stepId: gate.step_id, payloadHash: gate.payload_hash },
    now,
  )
  touch(ctx, orchId)
}

export function answerInquiry(
  ctx: Ctx,
  orchId: string,
  inquiryId: string,
  body: InquiryAnswer,
): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const inquiry = inquiriesOf(sqlite, orchId).find((candidate) => candidate.id === inquiryId)
  if (!inquiry) throw new HttpError(404, 'not_found', 'Unknown question')
  if (inquiry.status !== 'open' || inquiry.revision !== body.expectedRevision)
    throw new HttpError(409, 'conflict', 'This question was already answered or changed', {
      currentRevision: inquiry.revision,
    })
  sqlite
    .prepare(
      `UPDATE orc_inquiries SET status = 'answered', answer = ?, revision = revision + 1, answered_at = ? WHERE orchestration_id = ? AND id = ?`,
    )
    .run(body.answer, now, orchId, inquiryId)
  addStored(sqlite, orchId, utf8Bytes(body.answer))
  addCause(sqlite, orchId, 'inquiry_answered', inquiryId, now)
  addHistory(sqlite, orchId, 'inquiry_answered', { inquiryId }, now)
  touch(ctx, orchId)
}

export function setLimits(ctx: Ctx, orchId: string, body: LimitsDecision): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  if (isTerminalStatus(o.status)) throw new HttpError(409, 'conflict', `The run is ${o.status}`)
  if (body.deadlineAt !== undefined && body.deadlineAt !== null && body.deadlineAt <= now)
    throw new HttpError(400, 'bad_request', 'The deadline must be in the future')
  if (body.budgetUsd !== undefined)
    sqlite
      .prepare('UPDATE orchestrations SET budget_usd = ? WHERE id = ?')
      .run(body.budgetUsd, orchId)
  if (body.deadlineAt !== undefined)
    sqlite
      .prepare('UPDATE orchestrations SET deadline_at = ? WHERE id = ?')
      .run(body.deadlineAt, orchId)
  if (body.acceptUnknownSpend !== undefined)
    sqlite
      .prepare('UPDATE orchestrations SET accepted_unknown_spend = ? WHERE id = ?')
      .run(body.acceptUnknownSpend ? 1 : 0, orchId)
  // A pause caused by a limit ends with the decision about that limit; admission re-pauses if it still applies.
  if (
    o.status === 'paused' &&
    ['budget', 'unknown_spend', 'deadline'].includes(o.pause_reason ?? '')
  )
    sqlite
      .prepare("UPDATE orchestrations SET status = 'running', pause_reason = NULL WHERE id = ?")
      .run(orchId)
  addHistory(sqlite, orchId, 'limits_changed', { ...body, orchestrationRevision: undefined }, now)
  touch(ctx, orchId)
}

export function pauseRun(ctx: Ctx, orchId: string, body: RunControl): void {
  const o = requireOrch(ctx.sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  if (o.status === 'paused') return
  if (o.status !== 'running') throw new HttpError(409, 'conflict', `The run is ${o.status}`)
  ctx.sqlite
    .prepare("UPDATE orchestrations SET status = 'paused', pause_reason = 'person' WHERE id = ?")
    .run(orchId)
  addHistory(ctx.sqlite, orchId, 'paused', { by: 'person' }, ctx.now)
  touch(ctx, orchId)
}

/** Resume ends a pause only. It never lifts a fence, a cancel fence, a waiver or a hold (admission checks them itself). */
export function resumeRun(ctx: Ctx, orchId: string, body: RunControl): void {
  const o = requireOrch(ctx.sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  if (o.status === 'running') return
  if (o.status !== 'paused') throw new HttpError(409, 'conflict', `The run is ${o.status}`)
  ctx.sqlite
    .prepare("UPDATE orchestrations SET status = 'running', pause_reason = NULL WHERE id = ?")
    .run(orchId)
  addHistory(ctx.sqlite, orchId, 'resumed', {}, ctx.now)
  touch(ctx, orchId)
}

/**
 * Stop: an admission barrier. One transaction fences all further admissions (the status), retires queued work with a
 * disposition, withdraws gates and inquiries, refuses attempts not yet sent, and owes a Stop on every attempt that may
 * be running. The Stop fence is journaled before the commit.
 */
export function stopRun(ctx: Ctx, orchId: string, reason: 'stop' | 'deadline' = 'stop'): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  if (isTerminalStatus(o.status)) {
    // A finished run can still hold attempts that are not confirmed ended: Stop owes Hermes a Stop on each, without
    // reopening admission or releasing their capacity (that is abandonment's job).
    const open = attemptsOf(sqlite, orchId).filter(
      (a) =>
        ['send_started', 'running', 'unknown'].includes(a.state) && a.stop_requested_at === null,
    )
    if (open.length === 0) throw new HttpError(409, 'conflict', `The run is already ${o.status}`)
    for (const attempt of open) oweStop(sqlite, attempt, now)
    addHistory(
      sqlite,
      orchId,
      'stop_requested',
      { after: o.status, attempts: open.map((a) => a.id) },
      now,
    )
    journalSoft(ctx, () =>
      ctx.journal.append({ kind: 'stop_fence', orchestrationId: orchId, reason: 'stop_after_end' }),
    )
    touch(ctx, orchId)
    return
  }
  if (o.status === 'stopping') return
  sqlite
    .prepare(
      "UPDATE orchestrations SET status = 'stopping', pause_reason = NULL, stop_requested_at = ?, end_reason = ? WHERE id = ?",
    )
    .run(now, reason === 'deadline' ? 'deadline expired' : null, orchId)
  retireQueued(sqlite, orchId, 'not_started: stopped', now)
  withdrawGates(sqlite, orchId, now)
  withdrawInquiries(sqlite, orchId, now)
  for (const attempt of attemptsOf(sqlite, orchId)) {
    if (attempt.state === 'created') {
      refuseAttempt(sqlite, attempt, 'not dispatched: stopped', now)
      if (attempt.step_id)
        setStepStatus(sqlite, orchId, attempt.step_id, 'not_started', 'not_started: stopped', now)
    } else if (
      ['send_started', 'running', 'unknown'].includes(attempt.state) &&
      attempt.abandoned_at === null
    )
      oweStop(sqlite, attempt, now)
  }
  addHistory(sqlite, orchId, 'stop_requested', {}, now)
  journalSoft(ctx, () =>
    ctx.journal.append({ kind: 'stop_fence', orchestrationId: orchId, reason }),
  )
  touch(ctx, orchId)
}

export function grantWaiver(ctx: Ctx, orchId: string, body: WaiverDecision): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const fenced = cancelFenceAttempts(o, attemptsOf(sqlite, orchId))
  if (fenced.length === 0)
    throw new HttpError(409, 'conflict', 'No cancelled step may still be running')
  sqlite.prepare('UPDATE orchestrations SET waiver_at = ? WHERE id = ?').run(now, orchId)
  addHistory(sqlite, orchId, 'waiver', { attempts: fenced.map((a) => a.id) }, now)
  touch(ctx, orchId)
}

/**
 * Abandonment: a human action on attempts whose end is not confirmed. Releases their capacity and reservations, keeps
 * the Stop owed on each (it is retried until Hermes acknowledges), and records that late results are not consumed.
 * Never termination evidence. The run then waits for an explicit Resume.
 */
export function abandonAttempts(ctx: Ctx, orchId: string, body: AbandonDecision): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  const attempts = attemptsOf(sqlite, orchId)
  const steps = stepsOf(sqlite, orchId)
  for (const id of body.attemptIds) {
    const attempt = attempts.find((candidate) => candidate.id === id)
    if (!attempt) throw new HttpError(404, 'not_found', `Unknown attempt ${id}`)
    if (attempt.state !== 'unknown')
      throw new HttpError(
        409,
        'conflict',
        `${id} is ${attempt.state}; only an attempt that is not confirmed ended can be abandoned`,
      )
  }
  for (const id of body.attemptIds) {
    const attempt = attempts.find((candidate) => candidate.id === id)!
    sqlite
      .prepare(
        `UPDATE orc_attempts SET state = 'abandoned', abandoned_at = ?, reserved_usd = 0, retired = 1,
         stop_requested_at = COALESCE(stop_requested_at, ?), updated_at = ? WHERE id = ?`,
      )
      .run(now, now, now, id)
    const step = steps.find((candidate) => candidate.id === attempt.step_id)
    if (step && step.status === 'unknown') {
      setStepStatus(sqlite, orchId, step.id, 'failed', 'abandoned: not confirmed ended', now)
      addCause(sqlite, orchId, 'step_abandoned', step.id, now)
    }
  }
  cascadeBlocked(sqlite, orchId, now)
  addHistory(sqlite, orchId, 'abandoned', { attempts: body.attemptIds }, now)
  if (o.status === 'running')
    sqlite
      .prepare(
        "UPDATE orchestrations SET status = 'paused', pause_reason = 'abandonment' WHERE id = ?",
      )
      .run(orchId)
  touch(ctx, orchId)
}
