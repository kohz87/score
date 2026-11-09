import { redactBounded } from '../../redact.ts'
import { touch, type Ctx } from './ctx.ts'
import {
  applyClosure,
  dropUnlaunchedInput,
  causeClass,
  launchFacts,
  provenNoLaunch,
  readGeneration,
} from './coding-attempts.ts'
import { CODING_RESULT_BYTES } from '../../runtimes/coding/translate.ts'
import { REPLY_TOO_LARGE_PATTERN } from '../../runtimes/coding/note.ts'
import { bumpAdmission, recordRefusal, addCodingStored, setStepStatus } from './ops.ts'
import {
  addCause,
  addHistory,
  requireOrch,
  stepsOf,
  type AttemptRow,
  type OrchRow,
} from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'
import type { RunFacts } from './executor-run-facts.ts'

export const codingMethods = {
  /**
   * Closes a generation that provably launched nothing (design §6, M2). Refusal causes take 7.1's `send_refused` path
   * (counters, wait, lifetime limit); every other cause writes one `send_closed` record and moves the attempt and its
   * step as the cause table says, never touching the refusal counters.
   */
  closeCoding(
    this: OrchestratorRuntime,
    ctx: Ctx,
    o: OrchRow,
    attempt: AttemptRow,
    generation: number,
    cause: string,
  ): void {
    const { sqlite, now } = ctx
    const klass = causeClass(cause)
    if (klass === 'refusal') {
      try {
        ctx.journal.append({
          kind: 'send_refused',
          attemptId: attempt.id,
          orchestrationId: o.id,
          generation,
        })
      } catch (error) {
        ctx.journalFailure = error instanceof Error ? error.message : String(error)
        this.markUnknown(ctx, o, attempt, 'refusal_unjournaled')
        return
      }
      sqlite
        .prepare(
          'UPDATE orc_generations SET closed_cause = COALESCE(closed_cause, ?), closed_at = COALESCE(closed_at, ?) WHERE attempt_id = ? AND generation = ?',
        )
        .run(cause, now, attempt.id, generation)
      sqlite
        .prepare(
          "UPDATE message_runs SET state = 'failed' WHERE orchestration_attempt_id = ? AND generation = ? AND state = 'pending'",
        )
        .run(attempt.id, generation)
      dropUnlaunchedInput(sqlite, attempt.id, generation)
      sqlite.prepare('UPDATE orc_attempts SET run_id = NULL WHERE id = ?').run(attempt.id)
      recordRefusal(sqlite, o, attempt, generation, now)
      this.cooldown.set(o.id, this.nowMs() + this.retryMs)
      this.wakeAfter(this.retryMs)
      addHistory(sqlite, o.id, 'send_refused', { attemptId: attempt.id, generation, cause }, now)
      touch(ctx, o.id)
      return
    }
    try {
      ctx.journal.append({
        kind: 'send_closed',
        attemptId: attempt.id,
        orchestrationId: o.id,
        generation,
        cause,
      })
    } catch (error) {
      ctx.journalFailure = error instanceof Error ? error.message : String(error)
      this.markUnknown(ctx, o, attempt, 'closure_unjournaled')
      return
    }
    applyClosure(sqlite, o, attempt, generation, cause, now)
    if (klass === 'hold') {
      this.cooldown.set(o.id, this.nowMs() + this.retryMs)
      this.wakeAfter(this.retryMs)
      const fresh = requireOrch(sqlite, o.id)
      if (cause === 'budget') this.pauseFor(ctx, fresh, 'budget')
      if (cause === 'unknown_cost') this.pauseFor(ctx, fresh, 'unknown_spend')
      if (cause === 'subagent_total') this.pauseFor(ctx, fresh, 'subagent_total')
    } else if (klass === 'terminal') bumpAdmission(sqlite)
    addHistory(sqlite, o.id, 'send_closed', { attemptId: attempt.id, generation, cause }, now)
    touch(ctx, o.id)
  },

  /**
   * What a terminal run of a coding attempt means (design §6, §7). The launch's journal state decides: a launch that
   * provably never ran closes its generation; one that may have run needs end proof before anything is accepted.
   */
  reconcileCoding(
    this: OrchestratorRuntime,
    ctx: Ctx,
    o: OrchRow,
    attempt: AttemptRow,
    run: RunFacts & { id?: string },
  ): void {
    const { sqlite, now } = ctx
    // A frozen home writes no journal records and signals nothing (decision 71); the sweep tries again after the reset.
    if (this.options.fence.executionFrozenIn(sqlite) !== null) return
    const generation = readGeneration(sqlite, attempt.id, attempt.dispatch_generation)
    if (!generation) return void this.markUnknown(ctx, o, attempt, 'generation_missing')
    const facts = launchFacts(sqlite, ctx.journal, generation.launch_id)
    if (facts.kind === 'unreadable') return // the journal can't be read: fail closed, the fence reports it
    if (provenNoLaunch(facts)) {
      if (attempt.state !== 'running') return // an unknown attempt with no launch is settled by the person, not here
      const refusal = sqlite
        .prepare('SELECT cause FROM coding_refusals WHERE run_id = ?')
        .get(attempt.run_id!) as { cause: string } | undefined
      const cause =
        refusal?.cause ??
        (facts.kind === 'known' ? facts.revokeCause : null) ??
        // A run that Score's own restart interrupted before any launch was requested was never refused: it is a restart
        // (hold class, no readiness counters), not a failed start (F1 #6).
        (run.status === 'cancelled'
          ? 'stop'
          : run.status === 'interrupted'
            ? 'restart'
            : 'start_failed')
      return void this.closeCoding(ctx, o, attempt, attempt.dispatch_generation, cause)
    }
    // The launch may have executed. A released launch is the qualified release that resets the refusal streak (N7).
    if (facts.kind === 'known' && facts.mayHaveExecuted && attempt.refused_streak > 0)
      sqlite.prepare('UPDATE orc_attempts SET refused_streak = 0 WHERE id = ?').run(attempt.id)
    if (facts.kind !== 'known' || !facts.proof) {
      if (attempt.state === 'running') this.markUnknown(ctx, o, attempt, 'run_not_proven_ended')
      return
    }
    // Proof for an abandoned attempt is recorded and never consumed (the same path as any abandoned attempt).
    if (attempt.state === 'abandoned') {
      sqlite
        .prepare(
          'UPDATE orc_attempts SET evidence = ?, terminated_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          run.status === 'completed' ? 'completed' : 'failed',
          run.ended_at ?? now,
          now,
          attempt.id,
        )
      addHistory(sqlite, o.id, 'late_result', { attemptId: attempt.id, status: run.status }, now)
      return
    }
    const late = attempt.state !== 'running'
    const spend = this.spend(sqlite, attempt)
    const reply = sqlite
      .prepare('SELECT reply, truncated FROM coding_run_results WHERE run_id = ?')
      .get(attempt.run_id!) as { reply: string; truncated: number } | undefined
    // The retained copy in `coding_run_results` is part of the coding inventory too (F1 #7).
    if (reply) addCodingStored(sqlite, o.id, Buffer.byteLength(reply.reply))
    const status = run.status
    // A workflow node names why a coding step produced no usable answer (7.7c §3): the person reads this on the node.
    const failure =
      o.planner !== 'workflow'
        ? 'the step run failed'
        : REPLY_TOO_LARGE_PATTERN.test(`${run.error ?? ''}`)
          ? 'answer too long to read a verdict'
          : status === 'completed' && !reply
            ? 'no final answer'
            : 'the step run failed'
    const disposition: 'completed' | 'failed' | 'cancelled' =
      status === 'cancelled'
        ? 'cancelled'
        : status === 'completed' && reply
          ? 'completed'
          : 'failed'
    sqlite
      .prepare(
        `UPDATE orc_attempts SET state = 'terminated', evidence = ?, terminated_at = ?, unknown_reason = NULL,
           spend_usd = COALESCE(?, spend_usd), spend_complete = ?, settled = ?, reserved_usd = CASE WHEN ? = 1 THEN 0 ELSE reserved_usd END,
           result_text = ?, result_truncated = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        disposition === 'cancelled' ? null : disposition,
        run.ended_at ?? now,
        spend.usd,
        spend.complete ? 1 : 0,
        spend.complete ? 1 : 0,
        spend.complete ? 1 : 0,
        // The result belongs to the attempt only if it is accepted now, never from a late proof.
        !late && disposition === 'completed' ? reply!.reply : null,
        !late && disposition === 'completed' && reply!.truncated === 1 ? 1 : 0,
        now,
        attempt.id,
      )
    bumpAdmission(sqlite)
    const step = stepsOf(sqlite, o.id).find((candidate) => candidate.id === attempt.step_id)
    if (!step) return
    if (late || step.retired) {
      // Late proof closes the obligations and settles the accounting; its result is permanently non-consumable (§7).
      addHistory(
        sqlite,
        o.id,
        'late_result',
        { attemptId: attempt.id, stepId: step.id, status: disposition },
        now,
      )
      if (late && !step.retired && ['unknown', 'admitted'].includes(step.status)) {
        setStepStatus(
          sqlite,
          o.id,
          step.id,
          'failed',
          'ended after it was last seen: its result is not used',
          now,
        )
        addCause(sqlite, o.id, 'step_failed', step.id, now, 'ended after it was last seen')
      }
      return
    }
    if (disposition === 'cancelled') {
      // Obligations closed, no result, never retried.
      setStepStatus(sqlite, o.id, step.id, 'cancelled', 'stop', now)
      addCause(sqlite, o.id, 'step_cancelled', step.id, now, 'stopped')
      return
    }
    const text =
      disposition === 'completed'
        ? reply!.truncated === 1
          ? `${reply!.reply}\n[…cut at ${CODING_RESULT_BYTES / 1024} KiB by Score]`
          : reply!.reply
        : [run.output, run.error ? `[error] ${run.error}` : null].filter(Boolean).join('\n')
    const result = redactBounded(text, CODING_RESULT_BYTES + 128)
    sqlite
      .prepare(
        `UPDATE orc_steps SET status = ?, disposition = ?, result = ?, result_revision = result_revision + 1, updated_at = ? WHERE orchestration_id = ? AND id = ?`,
      )
      .run(
        disposition === 'completed' ? 'succeeded' : 'failed',
        disposition === 'failed' ? failure : null,
        result,
        now,
        o.id,
        step.id,
      )
    addCodingStored(
      sqlite,
      o.id,
      Buffer.byteLength(result) * 2 + Buffer.byteLength(run.output ?? ''),
    )
    this.stepEnded(ctx, o, step, disposition === 'completed', result, attempt.id)
  },
}

export type CodingMethods = typeof codingMethods
