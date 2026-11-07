import { createHash } from 'node:crypto'
import { isAdvisorStep } from './advisor.ts'
import { ok, policyField, quotaRefusal, refuse, type Handler } from './command-support.ts'
import { journalSoft, type Ctx } from './ctx.ts'
import { dropStepVote } from './helpers.ts'
import {
  addStored,
  cascadeBlocked,
  oweStop,
  refuseAttempt,
  setStepStatus,
  utf8Bytes,
  withdrawGates,
} from './ops.ts'
import { attemptsOf, gatesOf, isFinalStep, readStep, stepsOf, type OrchRow } from './store.ts'

/**
 * Retires a step: a queued one simply doesn't start; one that may be running is owed a Stop, and admissions in the run
 * wait until it is confirmed ended (or the person decides). True when a Stop is owed. Shared by orch.cancel and the
 * person's "Stop this step" (3.14).
 */
export function cancelStep(ctx: Ctx, o: OrchRow, stepId: string, why: string): boolean {
  const { sqlite, now } = ctx
  const step = readStep(sqlite, o.id, stepId)!
  const attempt = attemptsOf(sqlite, o.id).findLast((a) => a.step_id === stepId)
  let fence = false
  if (step.status === 'admitted' || step.status === 'unknown') {
    if (attempt && attempt.state === 'created')
      refuseAttempt(sqlite, attempt, 'cancelled before it was sent', now)
    else if (attempt && ['send_started', 'running', 'unknown'].includes(attempt.state)) {
      oweStop(sqlite, attempt, now)
      // The stop is journaled before this transaction commits (a restored database that lost it is detected).
      journalSoft(ctx, () =>
        ctx.journal.append({
          kind: 'stop_fence',
          orchestrationId: o.id,
          attemptId: attempt.id,
          reason: `cancel:${stepId}`,
        }),
      )
      fence = true
    }
  }
  setStepStatus(sqlite, o.id, stepId, 'cancelled', why, now)
  sqlite
    .prepare('UPDATE orc_steps SET retired = 1 WHERE orchestration_id = ? AND id = ?')
    .run(o.id, stepId)
  withdrawGates(sqlite, o.id, now, stepId)
  cascadeBlocked(sqlite, o.id, now)
  dropStepVote(ctx, o.id, stepId)
  return fence
}

export const requestApprovalCommand: Handler = (ctx, o, _attempt, args) => {
  const { sqlite, now } = ctx
  if (o.gate_policy !== 'lead-asks')
    return refuse(
      'not_lead_asks',
      `This run's gate policy is ${o.gate_policy}; approval requests only exist under lead-asks`,
    )
  const stepId = args.stepId as string
  const step = readStep(sqlite, o.id, stepId)
  if (!step || isAdvisorStep(step) || step.role === 'vote')
    return refuse('unknown_step', `${stepId} is not a step of this run`)
  if (attemptsOf(sqlite, o.id).some((x) => x.step_id === stepId))
    return refuse(
      'already_admitted',
      `${stepId} has already been admitted; approval is requested in orch.assign (needsApproval) before it can start`,
    )
  if (step.status !== 'queued')
    return refuse(
      'not_queued',
      `${stepId} is ${step.status}; approval can only be requested for a queued step that has not started`,
    )
  if (gatesOf(sqlite, o.id).some((gate) => gate.step_id === stepId && gate.status !== 'withdrawn'))
    return refuse('gate_exists', `${stepId} already has a gate`)
  const byId = new Map(stepsOf(sqlite, o.id).map((s) => [s.id, s]))
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
    ...policyField(sqlite, o.id, step.agent_id),
  }
  const text = JSON.stringify(payload)
  const quota = quotaRefusal(o, utf8Bytes(text))
  if (quota) return quota
  const gateId = `g${gatesOf(sqlite, o.id).length + 1}`
  sqlite
    .prepare(
      `INSERT INTO orc_gates (orchestration_id, id, step_id, requested_by, payload, payload_hash, status, created_at)
       VALUES (?, ?, ?, 'lead', ?, ?, 'open', ?)`,
    )
    .run(o.id, gateId, stepId, text, createHash('sha256').update(text).digest('hex'), now)
  setStepStatus(sqlite, o.id, stepId, 'pending_gate', null, now)
  addStored(sqlite, o.id, utf8Bytes(text))
  return ok({ gateId, stepId })
}

export const cancelCommand: Handler = (ctx, o, _attempt, args) => {
  const stepId = args.stepId as string
  const step = readStep(ctx.sqlite, o.id, stepId)
  if (!step || isAdvisorStep(step))
    return refuse('unknown_step', `${stepId} is not a step of this run`)
  if (isFinalStep(step.status) || step.retired)
    return refuse('already_final', `${stepId} is already ${step.status}`)
  const fence = cancelStep(ctx, o, stepId, 'cancelled by the lead')
  return ok({ stepId, status: 'cancelled', admitted: fence, admissionsFenced: fence })
}
