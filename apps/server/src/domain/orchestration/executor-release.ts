import { type DatabaseSync } from 'node:sqlite'
import { HttpError } from '../../errors.ts'
import { isNotDispatched } from '../../hermes/index.ts'
import { touch, type Ctx } from './ctx.ts'
import { readWorkerPolicy } from './coding-policy.ts'
import { admissionDenial } from './admission.ts'
import { readGeneration } from './coding-attempts.ts'
import { type ReleaseDecision } from './owner.ts'
import { recordRefusal, refuseAttempt, setStepStatus } from './ops.ts'
import { isForbiddenPermission } from './supported-agents.ts'
import {
  addCause,
  readAttempt,
  readOrch,
  requireOrch,
  type AttemptRow,
  type OrchRow,
} from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'
import type { ReleaseSubject } from './executor-types.ts'

/** The typed cause a coding runtime attached to a refusal raised before the run was queued, if any. */
function codingFailureCause(error: unknown): string | undefined {
  if (!(error instanceof HttpError)) return undefined
  const details = error.details as { cause?: unknown } | null | undefined
  return typeof details?.cause === 'string' ? details.cause : undefined
}

export const releaseMethods = {
  recordSendFailure(
    this: OrchestratorRuntime,
    ctx: Ctx,
    attemptId: string,
    error: unknown,
    generation: number | null,
  ): void {
    const { sqlite, now } = ctx
    const attempt = readAttempt(sqlite, attemptId)
    if (!attempt || attempt.state !== 'send_started') return
    if (generation !== null && attempt.dispatch_generation !== generation) return
    const o = requireOrch(sqlite, attempt.orchestration_id)
    const cause = generation === null ? undefined : codingFailureCause(error)
    if (generation !== null && cause !== undefined) {
      // `startRun` threw before the run was queued, so nothing was launched: the generation is closed (or refused) by
      // its typed cause. A throw that carries no cause stays on the ordinary paths below.
      this.closeCoding(ctx, o, attempt, generation, cause)
      return
    }
    const definite =
      error instanceof HttpError &&
      error.status >= 400 &&
      error.status < 500 &&
      ![408, 409, 429].includes(error.status)
    if (isNotDispatched(error) && attempt.kind === 'step') {
      this.refuseDispatch(ctx, o, attempt)
      return
    }
    if (isNotDispatched(error)) {
      // Provably nothing was sent: put the work back and try again after a pause.
      sqlite
        .prepare(
          "UPDATE orc_attempts SET state = 'refused', unknown_reason = 'not_dispatched', terminated_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, attemptId)
      sqlite
        .prepare("UPDATE message_runs SET state = 'failed' WHERE turn_id = ? AND state = 'pending'")
        .run(attempt.turn_id)
      if (attempt.kind === 'lead')
        sqlite
          .prepare(
            'UPDATE orchestrations SET causes_consumed_up_to = ?, lead_turns_used = lead_turns_used - 1 WHERE id = ?',
          )
          .run(attempt.claim_from ?? 0, o.id)
      else if (attempt.step_id) setStepStatus(sqlite, o.id, attempt.step_id, 'queued', null, now)
      sqlite
        .prepare(
          'UPDATE orc_capabilities SET expired_at = ? WHERE attempt_id = ? AND expired_at IS NULL',
        )
        .run(now, attemptId)
      this.cooldown.set(o.id, this.nowMs() + this.retryMs)
    } else if (definite) {
      refuseAttempt(sqlite, attempt, error instanceof HttpError ? error.code : 'refused', now)
      sqlite
        .prepare(
          'UPDATE orc_capabilities SET expired_at = ? WHERE attempt_id = ? AND expired_at IS NULL',
        )
        .run(now, attemptId)
      if (attempt.step_id) {
        setStepStatus(sqlite, o.id, attempt.step_id, 'failed', 'admission_refused', now)
        addCause(
          sqlite,
          o.id,
          'step_failed',
          attempt.step_id,
          now,
          'Hermes refused to start the step',
        )
      } else {
        sqlite
          .prepare(
            'UPDATE orchestrations SET consecutive_lead_failures = consecutive_lead_failures + 1 WHERE id = ?',
          )
          .run(o.id)
        addCause(sqlite, o.id, 'lead_failed', attempt.id, now, 'Hermes refused to start the turn')
      }
    } else {
      this.markUnknown(ctx, o, attempt, 'admission_uncertain')
      // A Stop owed to a run whose handle never arrived is kept; the attempt stays fenced until resolved.
    }
    touch(ctx, o.id)
  },

  /**
   * v8.2 / v8.3: a proven refusal of one dispatch generation of a step attempt. The refusal is journaled (fsync) in the
   * transaction that returns the attempt to `created`; if it cannot be journaled the attempt stays sent/unknown. The
   * generation is not a logical attempt. After five refusals in a row the attempt waits (ten minutes, or a readiness
   * change); at twenty over its lifetime only the person continues a workflow node, and an orchestration step fails.
   */
  refuseDispatch(this: OrchestratorRuntime, ctx: Ctx, o: OrchRow, attempt: AttemptRow): void {
    const { sqlite, now } = ctx
    try {
      ctx.journal.append({
        kind: 'send_refused',
        attemptId: attempt.id,
        orchestrationId: o.id,
        generation: attempt.dispatch_generation,
      })
    } catch (error) {
      ctx.journalFailure = error instanceof Error ? error.message : String(error)
      this.markUnknown(ctx, o, attempt, 'refusal_unjournaled')
      return
    }
    recordRefusal(sqlite, o, attempt, attempt.dispatch_generation, now)
    if (attempt.kind === 'step') this.cooldown.set(o.id, this.nowMs() + this.retryMs)
    touch(ctx, o.id)
  },

  // ---------------------------------------------------------------------------------------- coding: release and closure

  /**
   * The executor's answer at the release critical section (7.7b §6): the common admission rules, the phase guard for
   * this generation and launch, the deadline the launch was prepared with, then the policy and limit checks (part 2).
   * A pure read: it never writes and never awaits, and says no with a typed cause.
   */
  decideRelease(
    this: OrchestratorRuntime,
    sqlite: DatabaseSync,
    subject: ReleaseSubject,
  ): ReleaseDecision {
    const no = (cause: string): ReleaseDecision => ({ allowed: false, cause })
    const attempt = readAttempt(sqlite, subject.attemptId)
    const generation = attempt ? readGeneration(sqlite, attempt.id, subject.generation) : undefined
    const o = attempt ? readOrch(sqlite, attempt.orchestration_id) : undefined
    // The phase guard: release needs `send_started` or `running` for THIS generation, this launch, and this launch's
    // handle or none yet. Anything else means the attempt moved on without this launch.
    if (!attempt || !generation || !o || generation.launch_id !== subject.launchId)
      return no('retired')
    if (
      attempt.dispatch_generation !== subject.generation ||
      generation.closed_cause !== null ||
      !['send_started', 'running'].includes(attempt.state) ||
      (attempt.run_id !== null &&
        generation.run_id !== null &&
        attempt.run_id !== generation.run_id)
    )
      return no('retired')
    const nowMs = this.nowMs()
    const denial = admissionDenial(
      sqlite,
      this.options.fence,
      o,
      attempt,
      new Date(nowMs).toISOString(),
    )
    if (denial) return no(denial.cause)
    // The prepared expiry may not outlive the deadline as it stands now (it can move earlier while a launch is arming).
    if (o.deadline_at !== null && subject.expiry > Date.parse(o.deadline_at))
      return no('deadline_changed')
    // A coding worker: the prepared invocation is the stored policy's, every external identity is read once more (inside
    // the critical section, immediately before `releasing`), and the run's coding step limit still has room (7.7b §3, §8).
    if (attempt.kind === 'step' && attempt.runtime !== 'hermes') {
      const stored = readWorkerPolicy(sqlite, o.id, attempt.agent_id)
      if (!stored || subject.policyId !== stored.policyId) return no('agent_changed')
      // A stored policy with a permission workers may never have (a damaged or hand-edited row) never launches.
      if (isForbiddenPermission(stored.policy.permission)) return no('permission_forbidden')
      const check = this.options.codingFacts?.checkPolicy(attempt.agent_id, stored.policy)
      if (!check) return no('agent_changed')
      if (!check.ok) return no(check.cause)
      if (check.id !== stored.policyId) return no('agent_changed')
      if ((subject.executed ?? 0) >= o.coding_steps) return no('limit')
    }
    // Extra checks (tests inject causes here): the policy and the limits.
    const refused =
      this.options.releaseChecks?.policy?.(sqlite, subject) ??
      this.options.releaseChecks?.limits?.(sqlite, subject)
    return refused === undefined ? { allowed: true } : no(refused)
  },
}

export type ReleaseMethods = typeof releaseMethods
