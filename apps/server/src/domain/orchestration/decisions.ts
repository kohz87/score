import type {
  AbandonDecision,
  GateDecision,
  InquiryAnswer,
  LimitsDecision,
  RemapDecision,
  RunControl,
  WaiverDecision,
} from '@score/contract'
import { HttpError } from '../../errors.ts'
import { lifecycleOf } from '../agent-lifecycle.ts'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import {
  addStored,
  bumpAdmission,
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
  frozenIncarnation,
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
      'This run changed while you were looking. Reload and try again.',
      {
        currentRevision: o.revision,
      },
    )
}

const mustBeLive = (o: OrchRow): void => {
  if (isTerminalStatus(o.status) || o.status === 'stopping' || o.status === 'finishing')
    throw new HttpError(409, 'conflict', `This run is ${o.status}.`)
}

export function decideGate(ctx: Ctx, orchId: string, gateId: string, body: GateDecision): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const gate = readGate(sqlite, orchId, gateId)
  if (!gate) throw new HttpError(404, 'not_found', 'Couldn’t find that gate.')
  if (gate.status !== 'open' || gate.revision !== body.expectedRevision)
    throw new HttpError(409, 'conflict', 'This gate was already decided or has changed.', {
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
  if (!inquiry) throw new HttpError(404, 'not_found', 'Couldn’t find that question.')
  if (inquiry.status !== 'open' || inquiry.revision !== body.expectedRevision)
    throw new HttpError(409, 'conflict', 'This question was already answered or has changed.', {
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
  if (isTerminalStatus(o.status)) throw new HttpError(409, 'conflict', `This run is ${o.status}.`)
  if (body.deadlineAt !== undefined && body.deadlineAt !== null && body.deadlineAt <= now)
    throw new HttpError(400, 'bad_request', 'The deadline must be in the future.')
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
    // The condition is gone; a manual hold that is still there keeps the run paused, now for its own reason.
    sqlite
      .prepare(
        o.manual_paused_at !== null
          ? "UPDATE orchestrations SET pause_reason = 'person' WHERE id = ?"
          : "UPDATE orchestrations SET status = 'running', pause_reason = NULL WHERE id = ?",
      )
      .run(orchId)
  addHistory(sqlite, orchId, 'limits_changed', { ...body, orchestrationRevision: undefined }, now)
  bumpAdmission(sqlite)
  // Every change is journaled as the full resulting state, so a database that lost a tightening is detected at start.
  const after = requireOrch(sqlite, orchId)
  journalSoft(ctx, () =>
    ctx.journal.append({
      kind: 'authorization',
      orchestrationId: orchId,
      budgetUsd: after.budget_usd,
      deadlineAt: after.deadline_at,
      acceptUnknownSpend: after.accepted_unknown_spend,
    }),
  )
  touch(ctx, orchId)
}

export function pauseRun(ctx: Ctx, orchId: string, body: RunControl): void {
  const o = requireOrch(ctx.sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  if (o.status === 'paused' && o.manual_paused_at !== null) return
  if (o.status !== 'running' && o.status !== 'paused')
    throw new HttpError(409, 'conflict', `This run is ${o.status}.`)
  // The manual hold is its own fact. Pausing a run that a budget (or any other condition) already paused keeps that
  // condition's reason; the hold outlives it (fix-h item 5).
  ctx.sqlite
    .prepare(
      o.status === 'running'
        ? "UPDATE orchestrations SET status = 'paused', pause_reason = 'person', manual_paused_at = ? WHERE id = ?"
        : 'UPDATE orchestrations SET manual_paused_at = ? WHERE id = ?',
    )
    .run(ctx.now, orchId)
  addHistory(ctx.sqlite, orchId, 'paused', { by: 'person' }, ctx.now)
  journalSoft(ctx, () =>
    ctx.journal.append({ kind: 'transition', orchestrationId: orchId, what: 'pause' }),
  )
  touch(ctx, orchId)
}

/** Resume ends a pause only. It never lifts a fence, a cancel fence, a waiver or a hold (admission checks them itself). */
export function resumeRun(ctx: Ctx, orchId: string, body: RunControl): void {
  const o = requireOrch(ctx.sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  if (o.status === 'running') return
  if (o.status !== 'paused') throw new HttpError(409, 'conflict', `This run is ${o.status}.`)
  // Resume ends the manual hold. A budget / unknown-spend / deadline pause is that condition's own and stays until the
  // limits decision (or, without a manual hold, is simply re-evaluated by admission as before).
  const limitPause = ['budget', 'unknown_spend', 'deadline'].includes(o.pause_reason ?? '')
  if (limitPause && o.manual_paused_at !== null)
    ctx.sqlite.prepare('UPDATE orchestrations SET manual_paused_at = NULL WHERE id = ?').run(orchId)
  else
    ctx.sqlite
      .prepare(
        "UPDATE orchestrations SET status = 'running', pause_reason = NULL, manual_paused_at = NULL WHERE id = ?",
      )
      .run(orchId)
  addHistory(ctx.sqlite, orchId, 'resumed', {}, ctx.now)
  bumpAdmission(ctx.sqlite)
  journalSoft(ctx, () =>
    ctx.journal.append({ kind: 'transition', orchestrationId: orchId, what: 'resume' }),
  )
  touch(ctx, orchId)
}

/**
 * Stop: an admission barrier. One transaction fences all further admissions (the status), retires queued work with a
 * disposition, withdraws gates and inquiries, refuses attempts not yet sent, and owes a Stop on every attempt that may
 * be running. The Stop fence is journaled before the commit.
 */
export function stopRun(
  ctx: Ctx,
  orchId: string,
  reason: 'stop' | 'deadline' | 'graph' = 'stop',
  endReason: string | null = null,
): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  if (isTerminalStatus(o.status)) {
    // A finished run can still hold attempts that are not confirmed ended: Stop owes Hermes a Stop on each, without
    // reopening admission or releasing their capacity (that is abandonment's job).
    const open = attemptsOf(sqlite, orchId).filter(
      (a) =>
        ['send_started', 'running', 'unknown'].includes(a.state) && a.stop_requested_at === null,
    )
    if (open.length === 0) throw new HttpError(409, 'conflict', `This run is already ${o.status}.`)
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
    .run(now, reason === 'deadline' ? 'deadline expired' : endReason, orchId)
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
    throw new HttpError(
      409,
      'conflict',
      'No stopped step may still be running, so there is nothing to confirm.',
    )
  sqlite.prepare('UPDATE orchestrations SET waiver_at = ? WHERE id = ?').run(now, orchId)
  addHistory(sqlite, orchId, 'waiver', { attempts: fenced.map((a) => a.id) }, now)
  bumpAdmission(sqlite)
  journalSoft(ctx, () =>
    ctx.journal.append({ kind: 'transition', orchestrationId: orchId, what: 'waiver' }),
  )
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
    if (!attempt) throw new HttpError(404, 'not_found', `Couldn’t find step run ${id}.`)
    if (attempt.state !== 'unknown')
      throw new HttpError(
        409,
        'conflict',
        `${id} is ${attempt.state}. Only a step run not confirmed as ended can be stopped waiting for.`,
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
    // A result accepted from recovered text is never restored as a success (fix-i 2).
    if (
      step &&
      (step.status === 'unknown' ||
        (step.status === 'succeeded' && attempt.unknown_reason === 'recovered_text_only'))
    ) {
      setStepStatus(
        sqlite,
        orchId,
        step.id,
        'failed',
        'stopped waiting: not confirmed as ended',
        now,
      )
      addCause(sqlite, orchId, 'step_abandoned', step.id, now)
    }
  }
  cascadeBlocked(sqlite, orchId, now)
  addHistory(sqlite, orchId, 'abandoned', { attempts: body.attemptIds }, now)
  bumpAdmission(sqlite)
  journalSoft(ctx, () =>
    ctx.journal.append({
      kind: 'transition',
      orchestrationId: orchId,
      what: 'abandon',
      attemptIds: body.attemptIds,
    }),
  )
  if (o.status === 'running')
    sqlite
      .prepare(
        "UPDATE orchestrations SET status = 'paused', pause_reason = 'abandonment' WHERE id = ?",
      )
      .run(orchId)
  touch(ctx, orchId)
}

/**
 * "Use the new <agent> for this run": the person's answer to a replaced agent. Paired with the exact frozen and current
 * incarnations the page showed; anything else is a conflict (the agent was replaced again, or the run was remapped). Steps
 * assigned under the old mapping stay blocked: the lead assigns again under the new one.
 */
export function remapAgent(ctx: Ctx, orchId: string, body: RemapDecision): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const frozen = frozenIncarnation(sqlite, orchId, body.agentId)
  if (frozen === undefined)
    throw new HttpError(404, 'not_found', `${body.agentId} is not an agent of this run.`)
  const current = lifecycleOf(sqlite, body.agentId)?.incarnation_id ?? 'untracked'
  if (
    frozen !== body.frozenIncarnation ||
    current !== body.currentIncarnation ||
    current === 'untracked'
  )
    throw new HttpError(409, 'conflict', `${body.agentId} changed again. Look at the run again.`)
  if (frozen === current) throw new HttpError(409, 'conflict', `${body.agentId} was not replaced.`)
  // The journal entry comes first: a database that later lacks this remap is detected at start.
  journalSoft(ctx, () =>
    ctx.journal.append({
      kind: 'remap',
      orchestrationId: orchId,
      agentId: body.agentId,
      incarnation: current,
    }),
  )
  sqlite
    .prepare(
      'UPDATE orc_agent_map SET incarnation = ?, updated_at = ? WHERE orchestration_id = ? AND agent_id = ?',
    )
    .run(current, now, orchId, body.agentId)
  if (body.agentId === o.lead_agent_id) {
    sqlite
      .prepare('UPDATE orchestrations SET lead_incarnation = ? WHERE id = ?')
      .run(current, orchId)
    // The pause this replacement caused ends with the decision about it; admission re-pauses if something else applies.
    // Only that condition goes: a manual hold that is still there keeps the run paused, now for its own reason.
    if (o.status === 'paused' && o.pause_reason === 'agent_unavailable')
      sqlite
        .prepare(
          o.manual_paused_at !== null
            ? "UPDATE orchestrations SET pause_reason = 'person' WHERE id = ?"
            : "UPDATE orchestrations SET status = 'running', pause_reason = NULL WHERE id = ?",
        )
        .run(orchId)
  }
  addHistory(
    sqlite,
    orchId,
    'agent_remapped',
    { agentId: body.agentId, from: frozen, to: current },
    now,
  )
  // The lead learns of it (an assignment it was refused may now succeed).
  addCause(sqlite, orchId, 'agent_remapped', body.agentId, now)
  bumpAdmission(sqlite)
  touch(ctx, orchId)
}
