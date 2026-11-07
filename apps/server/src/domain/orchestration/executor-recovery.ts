import { journalSoft, touch, type Ctx } from './ctx.ts'
import { launchFacts, provenNoLaunch, readGeneration } from './coding-attempts.ts'
import { setStepStatus } from './ops.ts'
import {
  addCause,
  addHistory,
  attemptsOf,
  isTerminalStatus,
  listOrchs,
  stepsOf,
  type AttemptRow,
  type OrchRow,
} from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'
import { isCodingStep } from './executor-run-facts.ts'

export const recoveryMethods = {
  async recover(this: OrchestratorRuntime): Promise<void> {
    await this.mutate((ctx) => {
      const { sqlite, now } = ctx
      // 3.13: a check that was running when Score stopped went down with it: never a pass.
      for (const row of sqlite
        .prepare("SELECT id, orchestration_id FROM orc_checks WHERE outcome = 'running'")
        .all() as { id: string; orchestration_id: string }[]) {
        sqlite
          .prepare("UPDATE orc_checks SET outcome = 'interrupted', ended_at = ? WHERE id = ?")
          .run(now, row.id)
        addCause(
          sqlite,
          row.orchestration_id,
          'check_interrupted',
          row.id,
          now,
          'Score restarted while it ran',
        )
      }
      this.repairRecoveredResults(ctx)
      this.backfillLegacyMappings(ctx)
      for (const o of listOrchs(sqlite)) {
        if (isTerminalStatus(o.status)) continue
        for (const attempt of attemptsOf(sqlite, o.id))
          if (attempt.state === 'send_started' && isCodingStep(attempt)) {
            this.recoverCodingSend(ctx, o, attempt)
          } else if (attempt.state === 'send_started') {
            // The adapter may have committed the handle Hermes returned before Score recorded it: keep it, so the
            // run can be observed and a Stop delivered. The attempt is still never resent.
            const committed =
              (
                sqlite
                  .prepare(
                    "SELECT result FROM command_intents WHERE idempotency_key = ? AND state = 'accepted' AND result IS NOT NULL",
                  )
                  .get(attempt.turn_id) as { result: string } | undefined
              )?.result ??
              (
                sqlite
                  .prepare('SELECT id FROM runs WHERE score_turn_id = ?')
                  .get(attempt.turn_id) as { id: string } | undefined
              )?.id
            if (committed) {
              sqlite
                .prepare(
                  "UPDATE orc_attempts SET run_id = ?, state = 'running', updated_at = ? WHERE id = ? AND run_id IS NULL",
                )
                .run(committed, now, attempt.id)
              journalSoft(ctx, () =>
                ctx.journal.append({ kind: 'run_handle', attemptId: attempt.id, runId: committed }),
              )
              addHistory(
                sqlite,
                o.id,
                'recovered_handle',
                { attemptId: attempt.id, runId: committed },
                now,
              )
              continue
            }
            this.markUnknown(ctx, o, attempt, 'crash_after_send_started')
            addHistory(sqlite, o.id, 'recovered_unknown', { attemptId: attempt.id }, now)
          }
        touch(ctx, o.id)
      }
    })
  },

  /**
   * Restart matrix, a coding generation that was `send_started` and has no handle (design §10). If the coding runtime
   * committed the run for this generation's turn, the handle is kept and the run's own end (interrupted by recovery)
   * decides. Otherwise the pre-minted launch id says what ran: absent from the coding journal (or revoked before
   * `releasing`) proves nothing launched and the generation is closed with cause `restart`; anything else is unknown.
   */
  recoverCodingSend(this: OrchestratorRuntime, ctx: Ctx, o: OrchRow, attempt: AttemptRow): void {
    const { sqlite, now } = ctx
    // A frozen home writes no journal record: the generation waits for reset-history (decision 71).
    if (this.options.fence.executionFrozenIn(sqlite) !== null) return
    const generation = readGeneration(sqlite, attempt.id, attempt.dispatch_generation)
    if (!generation) return void this.markUnknown(ctx, o, attempt, 'crash_after_send_started')
    const committed =
      (
        sqlite
          .prepare(
            "SELECT result FROM command_intents WHERE idempotency_key = ? AND state = 'accepted' AND result IS NOT NULL",
          )
          .get(generation.turn_id) as { result: string } | undefined
      )?.result ??
      (
        sqlite.prepare('SELECT id FROM runs WHERE score_turn_id = ?').get(generation.turn_id) as
          { id: string } | undefined
      )?.id
    if (committed) {
      sqlite
        .prepare(
          "UPDATE orc_attempts SET run_id = ?, state = 'running', updated_at = ? WHERE id = ? AND run_id IS NULL",
        )
        .run(committed, now, attempt.id)
      sqlite
        .prepare(
          'UPDATE orc_generations SET run_id = COALESCE(run_id, ?) WHERE attempt_id = ? AND generation = ?',
        )
        .run(committed, attempt.id, generation.generation)
      journalSoft(ctx, () =>
        ctx.journal.append({
          kind: 'run_handle',
          attemptId: attempt.id,
          runId: committed,
          generation: generation.generation,
        }),
      )
      addHistory(sqlite, o.id, 'recovered_handle', { attemptId: attempt.id, runId: committed }, now)
      return
    }
    const facts = launchFacts(sqlite, ctx.journal, generation.launch_id)
    if (facts.kind !== 'unreadable' && provenNoLaunch(facts)) {
      this.closeCoding(
        ctx,
        o,
        attempt,
        generation.generation,
        facts.kind === 'known' && facts.revokeCause ? facts.revokeCause : 'restart',
      )
      addHistory(sqlite, o.id, 'recovered_closed', { attemptId: attempt.id }, now)
      return
    }
    this.markUnknown(ctx, o, attempt, 'crash_after_send_started')
    addHistory(sqlite, o.id, 'recovered_unknown', { attemptId: attempt.id }, now)
  },

  markUnknown(
    this: OrchestratorRuntime,
    ctx: Ctx,
    o: OrchRow,
    attempt: AttemptRow,
    reason: string,
  ): void {
    const { sqlite, now } = ctx
    sqlite
      .prepare(
        "UPDATE orc_attempts SET state = 'unknown', unknown_reason = ?, updated_at = ? WHERE id = ?",
      )
      .run(reason, now, attempt.id)
    if (attempt.step_id) {
      const step = stepsOf(sqlite, o.id).find((candidate) => candidate.id === attempt.step_id)
      if (step && step.status === 'admitted') {
        setStepStatus(sqlite, o.id, step.id, 'unknown', reason, now)
        addCause(sqlite, o.id, 'step_unknown', step.id, now, reason)
      }
    } else addCause(sqlite, o.id, 'lead_unknown', attempt.id, now, reason)
    touch(ctx, o.id)
  },
}

export type RecoveryMethods = typeof recoveryMethods

export type RecoveryPublicMethods = Pick<RecoveryMethods, 'recover'>
