import type { QuotaDecision } from '@score/contract'
import { HttpError } from '../../errors.ts'
import { touch, type Ctx } from './ctx.ts'
import { expectRevision, mustBeLive } from './decision-guards.ts'
import { stopRun } from './decision-run-controls.ts'
import { bumpAdmission, setStepStatus } from './ops.ts'
import { holdOf } from './quota-guard.ts'
import { addHistory, attemptsOf, readStep, requireOrch, stepsOf } from './store.ts'

/**
 * 8.6: the answer to a held step. "Use it anyway" admits this step once (the hold stays as the person's override, so the
 * step isn't held again); "Wait until it resets" keeps it queued, quietly, until the window has reset and a fresh check
 * passes; "Stop the run" stops the run. The step must still be held and not started.
 */
export function answerQuota(ctx: Ctx, orchId: string, stepId: string, body: QuotaDecision): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const step = readStep(sqlite, orchId, stepId)
  if (!step) throw new HttpError(404, 'not_found', 'Couldn’t find that step.')
  const hold = holdOf(sqlite, orchId, stepId)
  if (!hold || hold.state !== 'held' || !['queued', 'pending_gate'].includes(step.status))
    throw new HttpError(409, 'conflict', 'This step isn’t held for a low limit.')
  if (body.answer === 'stop') {
    addHistory(sqlite, orchId, 'quota_stopped', { stepId, agentId: hold.agent_id }, now)
    stopRun(ctx, orchId)
    return
  }
  if (body.answer === 'use_anyway') {
    sqlite
      .prepare(
        "UPDATE orc_quota_holds SET state = 'override' WHERE orchestration_id = ? AND step_id = ?",
      )
      .run(orchId, stepId)
    sqlite
      .prepare(
        "UPDATE orc_steps SET disposition = NULL, updated_at = ? WHERE orchestration_id = ? AND id = ? AND disposition = 'quota_low'",
      )
      .run(now, orchId, stepId)
    addHistory(sqlite, orchId, 'quota_override', { stepId, agentId: hold.agent_id }, now)
  } else {
    sqlite
      .prepare(
        "UPDATE orc_quota_holds SET state = 'waiting' WHERE orchestration_id = ? AND step_id = ?",
      )
      .run(orchId, stepId)
    addHistory(
      sqlite,
      orchId,
      'quota_wait',
      { stepId, agentId: hold.agent_id, resetsAt: hold.resets_at },
      now,
    )
  }
  bumpAdmission(sqlite)
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
