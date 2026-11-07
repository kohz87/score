import { redactBounded } from '../../redact.ts'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import { journalDispatches } from './journal.ts'
import { refuseAttempt, setStepStatus } from './ops.ts'
import {
  addCause,
  addHistory,
  attemptsOf,
  isTerminalStatus,
  listOrchs,
  stepsOf,
  type AttemptRow,
} from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'

export const recoveryRepairMethods = {
  // ----------------------------------------------------------------------------------------------------- recovery

  /**
   * After a restart: an attempt whose admission was started but whose handle was never recorded is `unknown` and is
   * never replayed (design v3); attempts never sent (`created`) are dispatched again with a fresh capability.
   */
  /**
   * Upgrade repair (fix-i 2): migration 0049 turned attempts that ended on recovered session text into `unknown` but
   * left a result already accepted from them in place, where it kept satisfying dependencies (also after Abandon). The
   * text stays in the history; the step stops being a success, a run that finished on it is no longer clean, and a
   * dependent that was waiting on it is withdrawn. Idempotent: it only touches a `succeeded` step.
   */
  repairRecoveredResults(this: OrchestratorRuntime, ctx: Ctx): void {
    const { sqlite, now } = ctx
    for (const o of listOrchs(sqlite)) {
      const attempts = attemptsOf(sqlite, o.id)
      const steps = stepsOf(sqlite, o.id)
      let changed = false
      for (const step of steps) {
        if (step.status !== 'succeeded') continue
        const mine = attempts.filter((a) => a.step_id === step.id)
        const last = mine.reduce<AttemptRow | undefined>(
          (best, a) => (!best || a.n > best.n ? a : best),
          undefined,
        )
        if (
          !last ||
          last.unknown_reason !== 'recovered_text_only' ||
          !['unknown', 'abandoned'].includes(last.state)
        )
          continue
        changed = true
        const abandoned = last.state === 'abandoned'
        sqlite
          .prepare(
            'UPDATE orc_steps SET status = ?, disposition = ?, result = NULL, result_revision = result_revision + 1, updated_at = ? WHERE orchestration_id = ? AND id = ?',
          )
          .run(
            abandoned ? 'failed' : 'unknown',
            abandoned ? 'stopped waiting: not confirmed as ended' : 'recovered_text_only',
            now,
            o.id,
            step.id,
          )
        const viaGraph = new Set(
          (
            sqlite
              .prepare(
                'SELECT DISTINCT step_id FROM wf_consumed WHERE orchestration_id = ? AND producer_step = ?',
              )
              .all(o.id, step.id) as { step_id: string }[]
          ).map((row) => row.step_id),
        )
        sqlite
          .prepare(
            'UPDATE wf_consumed SET withdrawn = 1 WHERE orchestration_id = ? AND producer_step = ?',
          )
          .run(o.id, step.id)
        const consumers = steps.filter((c) => c.after_steps.includes(step.id) || viaGraph.has(c.id))
        const sentConsumers: { stepId: string; status: string }[] = []
        for (const consumer of consumers) {
          const latest = attemptsOf(sqlite, o.id)
            .filter((a) => a.step_id === consumer.id)
            .reduce<AttemptRow | undefined>(
              (best, a) => (!best || a.n > best.n ? a : best),
              undefined,
            )
          const unsent = latest?.state === 'created' && !this.journaledSend(ctx, latest.id)
          if (
            latest &&
            !unsent &&
            ['created', 'send_started', 'running', 'unknown'].includes(latest.state)
          ) {
            // Possibly sent: its obligations are unchanged; only recorded.
            sentConsumers.push({ stepId: consumer.id, status: consumer.status })
            continue
          }
          if (
            consumer.status === 'queued' ||
            consumer.status === 'pending_gate' ||
            (consumer.status === 'admitted' && unsent)
          ) {
            if (unsent && latest) {
              // Retired before it can ever be sent; its frozen input held the withdrawn text.
              refuseAttempt(
                sqlite,
                latest,
                'input_withdrawn: a result it consumed was withdrawn',
                now,
              )
              sqlite
                .prepare("UPDATE orc_attempts SET input = '[input withdrawn]' WHERE id = ?")
                .run(latest.id)
            }
            // An approval given on the strength of that result no longer stands.
            sqlite
              .prepare(
                "UPDATE orc_gates SET status = 'withdrawn', revision = revision + 1, decided_at = ? WHERE orchestration_id = ? AND step_id = ? AND status IN ('open', 'approved')",
              )
              .run(now, o.id, consumer.id)
            setStepStatus(
              sqlite,
              o.id,
              consumer.id,
              'blocked',
              `input_withdrawn: ${step.id} only ended on recovered text`,
              now,
            )
            addCause(sqlite, o.id, 'step_blocked', consumer.id, now, `after ${step.id}`)
          }
        }
        addHistory(
          sqlite,
          o.id,
          'recovered_result_withdrawn',
          {
            stepId: step.id,
            attemptId: last.id,
            text: step.result ? redactBounded(step.result, 500) : null,
            consumers: consumers.map((c) => ({ stepId: c.id, status: c.status })),
            sentConsumers,
          },
          now,
        )
        if (abandoned) addCause(sqlite, o.id, 'step_abandoned', step.id, now)
      }
      if (!changed) continue
      // A run that ended believing in that result did not end cleanly.
      if (o.status === 'succeeded')
        sqlite
          .prepare(
            "UPDATE orchestrations SET status = 'finished_with_unresolved', end_reason = 'a result recovered from session text was withdrawn' WHERE id = ?",
          )
          .run(o.id)
      touch(ctx, o.id)
    }
  },

  /** Whether the journal (or an unreadable journal, failing closed) says the attempt may have been sent. */
  journaledSend(this: OrchestratorRuntime, ctx: Ctx, attemptId: string): boolean {
    const journaled = ctx.journal.readOwn()
    if (!journaled.ok) return true
    return journalDispatches(journaled.entries).get(attemptId)?.state === 'sent'
  },

  /**
   * v8.1 item 1: a run from before 0049 got its mapping from the agents' current incarnations when that migration ran,
   * which silently adopted a replacement made earlier. Where a mapping was never remapped and the agent's first attempt
   * recorded another incarnation, the recorded one is restored (journaled), so the replacement shows up as a Remap.
   * Idempotent. A run with no attempt keeps the incarnation it got at migration time.
   */
  backfillLegacyMappings(this: OrchestratorRuntime, ctx: Ctx): void {
    const { sqlite, now } = ctx
    for (const o of listOrchs(sqlite)) {
      if (isTerminalStatus(o.status)) continue
      const rows = sqlite
        .prepare(
          'SELECT agent_id, incarnation, updated_at FROM orc_agent_map WHERE orchestration_id = ?',
        )
        .all(o.id) as { agent_id: string; incarnation: string; updated_at: string }[]
      for (const row of rows) {
        if (row.updated_at !== o.created_at) continue
        const first = sqlite
          .prepare(
            'SELECT agent_incarnation FROM orc_attempts WHERE orchestration_id = ? AND agent_id = ? ORDER BY created_at, rowid LIMIT 1',
          )
          .get(o.id, row.agent_id) as { agent_incarnation: string } | undefined
        if (!first || first.agent_incarnation === row.incarnation) continue
        journalSoft(ctx, () =>
          ctx.journal.append({
            kind: 'remap',
            orchestrationId: o.id,
            agentId: row.agent_id,
            incarnation: first.agent_incarnation,
          }),
        )
        sqlite
          .prepare(
            'UPDATE orc_agent_map SET incarnation = ? WHERE orchestration_id = ? AND agent_id = ?',
          )
          .run(first.agent_incarnation, o.id, row.agent_id)
        addHistory(
          sqlite,
          o.id,
          'mapping_backfilled',
          { agentId: row.agent_id, from: row.incarnation, to: first.agent_incarnation },
          now,
        )
        touch(ctx, o.id)
      }
    }
  },
}

export type RecoveryRepairMethods = typeof recoveryRepairMethods
