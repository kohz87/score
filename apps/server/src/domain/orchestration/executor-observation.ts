import { WORKFLOW_LIMITS, ORCH_LIMITS } from '@score/contract'
import { type DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { redactBounded } from '../../redact.ts'
import { type SpendReader } from './budget.ts'
import { touch, type Ctx } from './ctx.ts'
import { addStored, bumpAdmission } from './ops.ts'
import { readResult } from '../workflows/store.ts'
import { autoAuditStep } from './helpers.ts'
import { adviceArrived, adviseOnRepeatFailure, isAdvisorStep } from './advisor.ts'
import { queueCheckAfterStep } from './checks.ts'
import {
  AttemptRowSchema,
  addCause,
  addHistory,
  readOrch,
  stepsOf,
  type AttemptRow,
  type OrchRow,
  type StepRow,
} from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'
import { type RunFacts, isEvidence, isCodingStep, codingProofIn } from './executor-run-facts.ts'

export const observationMethods = {
  // ------------------------------------------------------------------------------------------------ observation

  /** What the observed runs say about attempts: termination evidence, late evidence, spend. Pure read. */
  plan(
    this: OrchestratorRuntime,
    sqlite: DatabaseSync,
  ): { attempt: AttemptRow; run: RunFacts; spend: ReturnType<SpendReader> }[] {
    const rows = z
      .array(AttemptRowSchema)
      .parse(
        sqlite
          .prepare(
            `SELECT * FROM orc_attempts WHERE run_id IS NOT NULL AND unknown_reason IS NOT 'history_reset' AND (state IN ('running', 'unknown') OR (state = 'abandoned' AND evidence IS NULL) OR (state = 'terminated' AND settled = 0))`,
          )
          .all(),
      )
    const work: { attempt: AttemptRow; run: RunFacts; spend: ReturnType<SpendReader> }[] = []
    for (const attempt of rows) {
      const run = sqlite
        .prepare('SELECT status, output, error, ended_at, terminal_source FROM runs WHERE id = ?')
        .get(attempt.run_id!) as RunFacts | undefined
      if (!run) continue
      const spend = this.spend(sqlite, attempt)
      const terminalRun = ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
      const evidence = isEvidence(run)
      const ends = isCodingStep(attempt)
        ? terminalRun &&
          (attempt.state === 'running' ||
            (['unknown', 'abandoned'].includes(attempt.state) && codingProofIn(sqlite, attempt)))
        : terminalRun &&
          ((attempt.state === 'running' && true) ||
            (attempt.state === 'unknown' && evidence) ||
            (attempt.state === 'abandoned' && evidence))
      const settle = attempt.state === 'terminated' && spend.complete
      const spendChanged =
        (spend.usd !== null && spend.usd !== attempt.spend_usd) ||
        spend.complete !== attempt.spend_complete ||
        settle !== attempt.settled
      if (ends || spendChanged) work.push({ attempt, run, spend })
    }
    return work
  },

  /** Reads the runs of live attempts and records termination evidence, results and spend. Returns whether anything changed. */
  async reconcile(this: OrchestratorRuntime): Promise<boolean> {
    if (this.db.read((sqlite) => this.plan(sqlite)).length === 0) return false
    return this.mutate((ctx) => this.reconcileAttempts(ctx))
  },

  reconcileAttempts(this: OrchestratorRuntime, ctx: Ctx): boolean {
    const { sqlite, now } = ctx
    let changed = false
    for (const { attempt, run, spend } of this.plan(sqlite)) {
      const o = readOrch(sqlite, attempt.orchestration_id)
      if (!o) continue
      changed = true
      touch(ctx, o.id)
      const evidence = isEvidence(run)
      const terminalRun =
        evidence ||
        run.status === 'completed' ||
        run.status === 'failed' ||
        run.status === 'cancelled' ||
        run.status === 'interrupted'
      if (isCodingStep(attempt)) {
        // A coding run's end is decided by its launch's journal state and proof, never by the run's own terminal word.
        const codingEnded =
          terminalRun &&
          (attempt.state === 'running' ||
            (['unknown', 'abandoned'].includes(attempt.state) && codingProofIn(sqlite, attempt)))
        if (codingEnded) this.reconcileCoding(ctx, o, attempt, run)
        else {
          const settle = attempt.state === 'terminated' && spend.complete
          sqlite
            .prepare(
              'UPDATE orc_attempts SET spend_usd = COALESCE(?, spend_usd), spend_complete = ?, settled = ?, reserved_usd = CASE WHEN ? = 1 THEN 0 ELSE reserved_usd END, updated_at = ? WHERE id = ?',
            )
            .run(spend.usd, spend.complete ? 1 : 0, settle ? 1 : 0, settle ? 1 : 0, now, attempt.id)
        }
        continue
      }
      const ending =
        terminalRun &&
        (attempt.state === 'running' ||
          (evidence && (attempt.state === 'unknown' || attempt.state === 'abandoned')))
      if (!ending) {
        const settle = attempt.state === 'terminated' && spend.complete
        sqlite
          .prepare(
            'UPDATE orc_attempts SET spend_usd = COALESCE(?, spend_usd), spend_complete = ?, settled = ?, reserved_usd = CASE WHEN ? = 1 THEN 0 ELSE reserved_usd END, updated_at = ? WHERE id = ?',
          )
          .run(spend.usd, spend.complete ? 1 : 0, settle ? 1 : 0, settle ? 1 : 0, now, attempt.id)
        continue
      }
      // Late evidence for an abandoned attempt is recorded and never consumed.
      if (attempt.state === 'abandoned') {
        sqlite
          .prepare(
            'UPDATE orc_attempts SET evidence = ?, terminated_at = ?, updated_at = ? WHERE id = ?',
          )
          .run(run.status, run.ended_at ?? now, now, attempt.id)
        addHistory(sqlite, o.id, 'late_result', { attemptId: attempt.id, status: run.status }, now)
        continue
      }
      if (evidence) this.accept(ctx, o, attempt, run.status as 'completed' | 'failed', run)
      // `cancelled` / `interrupted` do not prove the agent loop ended (7.1 v6): the attempt is unknown, not terminated.
      else if (run.terminal_source === 'recovered') {
        // The text is shown to the person (chat is unchanged) but proves nothing about the agent loop: obligations stay.
        addHistory(
          sqlite,
          o.id,
          'recovered_text',
          {
            attemptId: attempt.id,
            status: run.status,
            text: run.output ? redactBounded(run.output, 500) : null,
          },
          now,
        )
        this.markUnknown(ctx, o, attempt, 'recovered_text_only')
      } else this.markUnknown(ctx, o, attempt, `run_${run.status}`)
    }
    return changed
  },

  /** Termination evidence arrived: the attempt is terminated, and its output is accepted as the step result. */
  accept(
    this: OrchestratorRuntime,
    ctx: Ctx,
    o: OrchRow,
    attempt: AttemptRow,
    evidence: 'completed' | 'failed',
    run: { output: string | null; error: string | null; ended_at: string | null },
  ): void {
    const { sqlite, now } = ctx
    const spend = this.spend(sqlite, attempt)
    const settled = spend.complete
    sqlite
      .prepare(
        `UPDATE orc_attempts SET state = 'terminated', evidence = ?, terminated_at = ?, unknown_reason = NULL,
           spend_usd = COALESCE(?, spend_usd), spend_complete = ?, settled = ?, reserved_usd = CASE WHEN ? = 1 THEN 0 ELSE reserved_usd END, updated_at = ? WHERE id = ?`,
      )
      .run(
        evidence,
        run.ended_at ?? now,
        spend.usd,
        spend.complete ? 1 : 0,
        settled ? 1 : 0,
        settled ? 1 : 0,
        now,
        attempt.id,
      )
    sqlite
      .prepare(
        'UPDATE orc_capabilities SET expired_at = ? WHERE attempt_id = ? AND expired_at IS NULL',
      )
      .run(now, attempt.id)
    bumpAdmission(sqlite)
    if (attempt.kind === 'lead') {
      if (evidence === 'failed') {
        sqlite
          .prepare(
            'UPDATE orchestrations SET consecutive_lead_failures = consecutive_lead_failures + 1 WHERE id = ?',
          )
          .run(o.id)
        addCause(
          sqlite,
          o.id,
          'lead_failed',
          attempt.id,
          now,
          run.error ? redactBounded(run.error, 300) : 'the turn failed',
        )
      } else
        sqlite
          .prepare('UPDATE orchestrations SET consecutive_lead_failures = 0 WHERE id = ?')
          .run(o.id)
      return
    }
    const step = stepsOf(sqlite, o.id).find((candidate) => candidate.id === attempt.step_id)
    if (!step) return
    // A step the lead cancelled keeps its cancelled status; whatever it produced is recorded, not consumed.
    if (step.retired) {
      addHistory(
        sqlite,
        o.id,
        'late_result',
        { attemptId: attempt.id, stepId: step.id, status: evidence },
        now,
      )
      return
    }
    const message = sqlite
      .prepare('SELECT parts FROM messages WHERE id = ?')
      .get(attempt.message_id) as { parts: string } | undefined
    const messageText = message
      ? (JSON.parse(message.parts) as { kind: string; text?: string }[])
          .filter((part) => part.kind === 'text')
          .map((part) => part.text ?? '')
          .join('\n')
      : ''
    // A workflow step keeps up to 32 KiB, taken from the complete-reply facts recorded when the run ended (the run record
    // itself is cut at 8 KiB); orchestration steps keep 8 KiB.
    const workflow = o.planner === 'workflow'
    const facts = workflow ? readResult(sqlite, attempt.id) : undefined
    const body = facts?.output ?? run.output ?? (messageText || '')
    const limit = workflow ? WORKFLOW_LIMITS.outputBytes : ORCH_LIMITS.resultBytes
    const result = redactBounded(
      evidence === 'failed' && run.error ? `${body}\n[error] ${run.error}`.trim() : body,
      limit,
    )
    sqlite
      .prepare(
        `UPDATE orc_steps SET status = ?, disposition = ?, result = ?, result_revision = result_revision + 1, updated_at = ? WHERE orchestration_id = ? AND id = ?`,
      )
      .run(
        evidence === 'completed' ? 'succeeded' : 'failed',
        evidence === 'failed' ? 'the step run failed' : null,
        result,
        now,
        o.id,
        step.id,
      )
    // Every retained copy is charged (v8.1 item 5): the stored result, the streamed reply row and the run record.
    // Accepting a result never fails on quota: the protected reserve exists for exactly this.
    addStored(
      sqlite,
      o.id,
      Buffer.byteLength(result) +
        Buffer.byteLength(messageText) +
        Buffer.byteLength(run.output ?? ''),
    )
    this.stepEnded(ctx, o, step, evidence === 'completed', result, attempt.id)
  },

  // ---------------------------------------------------------------------------------------------------- stops

  /**
   * A step's result was accepted: the lead is told (an advisor consult as advice, 3.14), a check set to run after each
   * step is queued (3.13), and a failure like an earlier one is taken to the advisor.
   */
  stepEnded(
    this: OrchestratorRuntime,
    ctx: Ctx,
    o: OrchRow,
    step: StepRow,
    ok: boolean,
    result: string,
    attemptId: string,
  ): void {
    if (isAdvisorStep(step)) return adviceArrived(ctx, o, step, ok)
    // 3.15–3.16: a vote answer reaches the lead only through the tally, a scan part only with the whole scan
    // (settleHelpers); a helper's read-only work leaves nothing for the check to test.
    if (step.role === 'vote' || step.helper_role?.startsWith('scan_')) return
    addCause(ctx.sqlite, o.id, ok ? 'step_succeeded' : 'step_failed', step.id, ctx.now)
    // 3.14: a helper audits each of the lead's own steps that succeeded (when the person turned that on).
    if (ok && !step.role) autoAuditStep(ctx, o, step, result)
    if (ok && step.role !== 'helper') queueCheckAfterStep(ctx, o.id)
    else if (!ok)
      adviseOnRepeatFailure(ctx, o, { ...step, status: 'failed', result }, result, attemptId)
  },
}

export type ObservationMethods = typeof observationMethods
