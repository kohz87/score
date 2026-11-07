import type { AbandonDecision, RunControl, WaiverDecision } from '@score/contract'
import { HttpError } from '../../errors.ts'
import { cancelStep } from './commands.ts'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import { expectRevision, mustBeLive } from './decision-guards.ts'
import {
  bumpAdmission,
  cascadeBlocked,
  oweStop,
  refuseAttempt,
  retireQueued,
  setStepStatus,
  withdrawGates,
  withdrawInquiries,
} from './ops.ts'
import {
  addCause,
  addHistory,
  attemptsOf,
  isFinalStep,
  isTerminalStatus,
  readStep,
  requireOrch,
  stepsOf,
} from './store.ts'
import { cancelFenceAttempts } from './views.ts'

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

/**
 * 3.14 (owner: a step hung for 14 minutes and only stopping the whole job could end it): the person stops one step.
 * Same as the lead's orch.cancel; the lead is told and can reassign the work.
 */
export function personStopsStep(ctx: Ctx, orchId: string, stepId: string, body: RunControl): void {
  const o = requireOrch(ctx.sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  if (o.status !== 'running' && o.status !== 'paused')
    throw new HttpError(409, 'conflict', `This run is ${o.status}.`)
  const step = readStep(ctx.sqlite, orchId, stepId)
  if (!step || step.role === 'advisor' || step.role === 'vote')
    throw new HttpError(404, 'not_found', 'Couldn’t find that step.')
  if (isFinalStep(step.status) || step.retired)
    throw new HttpError(409, 'conflict', `That step is already ${step.status}.`)
  const fenced = cancelStep(ctx, o, stepId, 'stopped by the person')
  addHistory(ctx.sqlite, orchId, 'step_stopped', { stepId, by: 'person' }, ctx.now)
  // Only when this step is the one thing the job waits on: another stopped step that may still be running keeps its own
  // card, which lists what the person is agreeing to (review).
  const onlyThis = cancelFenceAttempts(
    requireOrch(ctx.sqlite, orchId),
    attemptsOf(ctx.sqlite, orchId),
  ).every((attempt) => attempt.step_id === stepId)
  if (fenced && onlyThis) {
    // The person's stop is also their decision to go on while the step may still be ending (the waiver): otherwise the
    // job would wait for a second confirmation that Hermes's cancelled run ended. The Stop stays owed until acknowledged.
    ctx.sqlite.prepare('UPDATE orchestrations SET waiver_at = ? WHERE id = ?').run(ctx.now, orchId)
    addHistory(ctx.sqlite, orchId, 'waiver', { stepId, by: 'stop_step' }, ctx.now)
    bumpAdmission(ctx.sqlite)
    journalSoft(ctx, () =>
      ctx.journal.append({ kind: 'transition', orchestrationId: orchId, what: 'waiver' }),
    )
  }
  addCause(
    ctx.sqlite,
    orchId,
    'step_cancelled',
    stepId,
    ctx.now,
    'stopped by the person; reassign the work if it is still needed',
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
