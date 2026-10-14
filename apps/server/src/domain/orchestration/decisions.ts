import type { DatabaseSync } from 'node:sqlite'
import type {
  AbandonDecision,
  GateDecision,
  InquiryAnswer,
  LimitsDecision,
  PolicyRemapDecision,
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
  CODING_ITEM_EXTRA_BYTES,
  codingItemsFor,
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
import { createHash } from 'node:crypto'
import { readWorkerPolicy, storeWorkerPolicy } from './coding-policy.ts'
import type { WorkerReport } from './supported-agents.ts'
import { gatesOf, readStep } from './store.ts'

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
    // A coding step re-gated after "use the new settings" still has its suspended, proven-unsent attempt: rejecting the
    // gate closes it in the same transaction, so its reservation doesn't outlive the step (F1 #5).
    for (const held of attemptsOf(sqlite, orchId).filter(
      (candidate) =>
        candidate.step_id === gate.step_id && candidate.suspended && candidate.state === 'created',
    ))
      refuseAttempt(sqlite, held, 'not dispatched: the gate was rejected', now)
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

export function setLimits(
  ctx: Ctx,
  orchId: string,
  body: LimitsDecision,
  storageFits: (sqlite: DatabaseSync, extraBytes: number) => boolean = () => true,
): void {
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
  if (body.acceptUnknownCost !== undefined) {
    const accepted = new Set(o.accepted_unknown_cost)
    for (const source of body.acceptUnknownCost.add ?? []) accepted.add(source)
    for (const source of body.acceptUnknownCost.remove ?? []) accepted.delete(source)
    sqlite
      .prepare('UPDATE orchestrations SET accepted_unknown_cost = ? WHERE id = ?')
      .run(JSON.stringify([...accepted].sort()), orchId)
  }
  if (body.codingSteps !== undefined) {
    // Each coding item the limit now allows holds its own inventory in the run's reserve. A higher limit grows the reserve
    // (a lower one keeps it), or is refused when the database has no storage for the growth (F1 #7).
    const hasWorkers =
      sqlite
        .prepare('SELECT 1 FROM orc_worker_policies WHERE orchestration_id = ? LIMIT 1')
        .get(orchId) !== undefined
    // Growth is measured against what is already reserved, not against the previous limit: 10 -> 4 -> 10 keeps ten
    // items' reserve and adds nothing (F2 #5).
    const reservedItems = Math.floor(o.coding_reserve_bytes / CODING_ITEM_EXTRA_BYTES)
    const grow = hasWorkers
      ? Math.max(0, codingItemsFor(o.max_steps, body.codingSteps) - reservedItems) *
        CODING_ITEM_EXTRA_BYTES
      : 0
    if (grow > 0 && !storageFits(sqlite, grow))
      throw new HttpError(
        409,
        'quota_exhausted',
        'Score has no storage left for more coding steps in this run.',
      )
    if (grow > 0)
      sqlite
        .prepare(
          'UPDATE orchestrations SET reserve_bytes = reserve_bytes + ?, coding_reserve_bytes = coding_reserve_bytes + ? WHERE id = ?',
        )
        .run(grow, grow, orchId)
    sqlite
      .prepare('UPDATE orchestrations SET coding_steps = ? WHERE id = ?')
      .run(body.codingSteps, orchId)
    // Raising the limit lets the steps it blocked go on: the same suspended attempt is admitted again (7.7b §12a).
    if (body.codingSteps > o.coding_steps) resumeSuspendedSteps(ctx, orchId, 'coding_limit')
  }
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
      codingSteps: after.coding_steps,
      acceptUnknownCost: after.accepted_unknown_cost,
    }),
  )
  touch(ctx, orchId)
}

/**
 * Steps blocked on a decision that was just taken (`coding_limit`, `agent_changed`) become queued again; admission then
 * re-admits the SAME suspended attempt (one attempt per step, K2). A step whose approval is no longer current goes back
 * to `pending_gate` through the policy remap, not through here.
 */
export function resumeSuspendedSteps(
  ctx: Ctx,
  orchId: string,
  disposition: string,
  only?: string,
): void {
  const { sqlite, now } = ctx
  const attempts = attemptsOf(sqlite, orchId)
  for (const step of stepsOf(sqlite, orchId)) {
    if (only !== undefined && step.id !== only) continue
    if (step.status !== 'blocked' || step.disposition !== disposition) continue
    if (!attempts.some((attempt) => attempt.step_id === step.id && attempt.suspended)) continue
    setStepStatus(sqlite, orchId, step.id, 'queued', null, now)
  }
  bumpAdmission(sqlite)
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
export function remapAgent(
  ctx: Ctx,
  orchId: string,
  body: RemapDecision,
  report?: WorkerReport,
): void {
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
  // A coding worker's replacement is approved by its new policy id and its reach, like a worker at the start (7.7b §12a).
  const codingPolicy = readWorkerPolicy(sqlite, orchId, body.agentId)
  if (codingPolicy) {
    if (!report || report.readiness !== 'ready' || !report.policy || report.policyId === null)
      throw new HttpError(
        409,
        'conflict',
        `${body.agentId} isn’t ready: ${report?.detail ?? 'Score couldn’t check it'}.`,
      )
    if (body.policyId !== report.policyId)
      throw new HttpError(
        409,
        'policy_changed',
        `${body.agentId} changed again. Look at what it can reach and decide again.`,
        { agentId: body.agentId, currentPolicyId: report.policyId },
      )
    if (
      report.reachBeyondWorkspace &&
      !body.acknowledgeCodingReach?.policyIds.includes(report.policyId)
    )
      throw new HttpError(
        409,
        'reach_not_acknowledged',
        `${body.agentId} can read beyond its workspace. Accept that to use it.`,
        { agentId: body.agentId, policyId: report.policyId },
      )
    storeWorkerPolicy(
      sqlite,
      orchId,
      body.agentId,
      {
        policyId: report.policyId,
        policy: report.policy,
        reach: report.reach!,
        reachBeyondWorkspace: report.reachBeyondWorkspace,
        acknowledged: report.reachBeyondWorkspace,
      },
      now,
    )
    if (report.reachBeyondWorkspace)
      addHistory(sqlite, orchId, 'coding_reach_acknowledged', { policyIds: [report.policyId] }, now)
  }
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

/**
 * "Use the new settings" (7.7b §12a): a step blocked `agent_changed` takes the SAME coding agent's current policy. The
 * decision is bound to the policy id the person saw and, when the reach goes beyond the workspace, to an acknowledgement
 * of that exact id. A gate approved for the old id is withdrawn and the step returns to `pending_gate` for a fresh
 * approval; without a gate the step is queued again. Either way admission re-admits the step's one suspended attempt.
 */
export function policyRemapStep(
  ctx: Ctx,
  orchId: string,
  stepId: string,
  body: PolicyRemapDecision,
  report: WorkerReport | undefined,
): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const step = readStep(sqlite, orchId, stepId)
  if (!step) throw new HttpError(404, 'not_found', 'Couldn’t find that step.')
  if (step.agent_id !== body.agentId)
    throw new HttpError(409, 'conflict', `${body.agentId} isn’t the agent of this step.`)
  const suspended = attemptsOf(sqlite, orchId).find(
    (attempt) => attempt.step_id === stepId && attempt.suspended,
  )
  if (step.status !== 'blocked' || step.disposition !== 'agent_changed' || !suspended)
    throw new HttpError(409, 'conflict', 'This step isn’t waiting for new settings.')
  const stored = readWorkerPolicy(sqlite, orchId, body.agentId)
  if (!stored) throw new HttpError(409, 'conflict', `${body.agentId} has no settings in this run.`)
  if (!report || report.readiness !== 'ready' || !report.policy || report.policyId === null)
    throw new HttpError(
      409,
      'conflict',
      `${body.agentId} isn’t ready: ${report?.detail ?? 'Score couldn’t check it'}.`,
    )
  if (report.policyId !== body.policyId)
    throw new HttpError(
      409,
      'policy_changed',
      `${body.agentId} changed again. Look at what it can reach and decide again.`,
      { agentId: body.agentId, currentPolicyId: report.policyId },
    )
  // Each suspended attempt carries the settings its own step was approved with. The agent's stored mapping may already
  // have moved on (another step of the same worker was remapped first), and this step still needs its own decision (F1 #4).
  if ((suspended.policy_id ?? stored.policyId) === body.policyId)
    throw new HttpError(
      409,
      'conflict',
      `${body.agentId} still has the settings this step was approved with.`,
    )
  if (
    report.reachBeyondWorkspace &&
    !body.acknowledgeCodingReach?.policyIds.includes(body.policyId)
  )
    throw new HttpError(
      409,
      'reach_not_acknowledged',
      `${body.agentId} can read beyond its workspace. Accept that to use the new settings.`,
      { agentId: body.agentId, policyId: body.policyId },
    )
  // The journal entry comes first: a database that later lacks this decision is detected at start.
  journalSoft(ctx, () =>
    ctx.journal.append({
      kind: 'policy_remap',
      orchestrationId: orchId,
      stepId,
      agentId: body.agentId,
      policyId: body.policyId,
    }),
  )
  storeWorkerPolicy(
    sqlite,
    orchId,
    body.agentId,
    {
      policyId: body.policyId,
      policy: report.policy,
      reach: report.reach!,
      reachBeyondWorkspace: report.reachBeyondWorkspace,
      acknowledged: body.acknowledgeCodingReach?.policyIds.includes(body.policyId) ?? false,
    },
    now,
  )
  if (report.reachBeyondWorkspace)
    addHistory(
      sqlite,
      orchId,
      'coding_reach_acknowledged',
      { policyIds: [body.policyId], stepId },
      now,
    )
  // The step's own attempt now carries the settings this decision approved (F2 #3).
  sqlite
    .prepare('UPDATE orc_attempts SET policy_id = ?, updated_at = ? WHERE id = ?')
    .run(body.policyId, now, suspended.id)
  const hadGate = gatesOf(sqlite, orchId).some((gate) => gate.step_id === stepId)
  // A gate approved (or still open) for the old settings no longer covers the step.
  sqlite
    .prepare(
      "UPDATE orc_gates SET status = 'withdrawn', revision = revision + 1, decided_at = ? WHERE orchestration_id = ? AND step_id = ? AND status IN ('open', 'approved')",
    )
    .run(now, orchId, stepId)
  if (hadGate || o.gate_policy === 'every-step') {
    const byId = new Map(stepsOf(sqlite, orchId).map((candidate) => [candidate.id, candidate]))
    const payload = {
      agentId: step.agent_id,
      agentIncarnation: step.agent_incarnation,
      instruction: step.instruction,
      after: step.after_steps,
      replaces: step.replaces,
      estimateUsd: step.estimate_usd,
      dependencyRevisions: Object.fromEntries(
        step.after_steps.map((dep) => [dep, byId.get(dep)?.result_revision ?? 0]),
      ),
      policyId: body.policyId,
    }
    const text = JSON.stringify(payload)
    sqlite
      .prepare(
        `INSERT INTO orc_gates (orchestration_id, id, step_id, requested_by, payload, payload_hash, status, created_at)
         VALUES (?, ?, ?, 'policy', ?, ?, 'open', ?)`,
      )
      .run(
        orchId,
        `g${gatesOf(sqlite, orchId).length + 1}`,
        stepId,
        text,
        createHash('sha256').update(text).digest('hex'),
        now,
      )
    addStored(sqlite, orchId, utf8Bytes(text))
    setStepStatus(sqlite, orchId, stepId, 'pending_gate', null, now)
  } else setStepStatus(sqlite, orchId, stepId, 'queued', null, now)
  addHistory(
    sqlite,
    orchId,
    'policy_remapped',
    { stepId, agentId: body.agentId, from: stored.policyId, to: body.policyId },
    now,
  )
  addCause(sqlite, orchId, 'policy_remapped', stepId, now)
  bumpAdmission(sqlite)
  touch(ctx, orchId)
}
