import { createHash, randomUUID } from 'node:crypto'
import { hashCapability, mintCapability } from './capability.ts'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import { applyJournalEvidence } from './fence.ts'
import { journalDispatches } from './journal.ts'
import { admissionDenial } from './admission.ts'
import { MAX_GENERATIONS, codingTurnId } from './coding-attempts.ts'
import { refuseAttempt, setStepStatus } from './ops.ts'
import {
  addCause,
  isTerminalStatus,
  readAttempt,
  readStep,
  requireOrch,
  type AttemptRow,
  type StepRow,
} from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'

export const sendMethods = {
  beginSend(
    this: OrchestratorRuntime,
    ctx: Ctx,
    attemptId: string,
  ):
    | {
        attempt: AttemptRow
        capability?: string
        coding?: { generation: number; turnId: string; launchId: string }
      }
    | undefined {
    const { sqlite, now } = ctx
    const attempt = readAttempt(sqlite, attemptId)
    if (!attempt || attempt.state !== 'created' || attempt.suspended) return undefined
    // Fresh run facts first (another dispatch may have been awaiting its reply while a sibling's run ended or was
    // recovered): every fence and hold below is judged on what reconciliation just established (fix-i 1).
    this.reconcileAttempts(ctx)
    const o = requireOrch(sqlite, attempt.orchestration_id)
    // The journal outlives the database: if it says this attempt's latest dispatch generation was sent, it is never sent
    // again. A proven refusal (`send_refused`) of that generation leaves it sendable as the next generation.
    const journaled = ctx.journal.readOwn()
    // Without a readable journal we can't prove this attempt was never sent: fail closed (the caller fences).
    if (!journaled.ok) throw new Error(`Execution journal is unreadable: ${journaled.reason}`)
    const dispatched = journalDispatches(journaled.entries).get(attempt.id)
    if (dispatched?.state === 'sent') {
      applyJournalEvidence(sqlite, journaled.entries, now)
      touch(ctx, o.id)
      return undefined
    }
    const refuse = (reason: string, step?: { status: StepRow['status']; disposition: string }) => {
      refuseAttempt(sqlite, attempt, reason, now)
      if (attempt.step_id && step)
        setStepStatus(sqlite, o.id, attempt.step_id, step.status, step.disposition, now)
      touch(ctx, o.id)
      return undefined
    }
    // The common admission rules, asked once (the release decision asks the same function). What each cause means for a
    // send: the first group ends the attempt, the second keeps it `created` until the condition clears.
    const denial = admissionDenial(sqlite, this.options.fence, o, attempt, now)
    if (denial && ['retired', 'cancel', 'stop'].includes(denial.cause))
      return refuse(`not dispatched: run ${o.status}`, {
        status: 'not_started',
        disposition: `not_started: run ${o.status}`,
      })
    // Result eligibility of everything the input consumed, judged at send (fix-j 2).
    if (denial?.cause === 'inputs_withdrawn') {
      const withdrawn = denial.withdrawn!
      refuseAttempt(sqlite, attempt, `input_withdrawn: ${withdrawn}`, now)
      sqlite
        .prepare(
          "UPDATE orc_gates SET status = 'withdrawn', revision = revision + 1, decided_at = ? WHERE orchestration_id = ? AND step_id = ? AND status IN ('open', 'approved')",
        )
        .run(now, o.id, attempt.step_id!)
      setStepStatus(sqlite, o.id, attempt.step_id!, 'blocked', `input_withdrawn: ${withdrawn}`, now)
      addCause(sqlite, o.id, 'step_blocked', attempt.step_id!, now, 'input_withdrawn')
      touch(ctx, o.id)
      return undefined
    }
    // The input is exactly what was frozen and, for workflows, approved: the dispatched bytes hash to the frozen hash.
    if (attempt.kind === 'step' && attempt.step_id) {
      const frozenStep = readStep(sqlite, o.id, attempt.step_id)
      if (
        frozenStep?.payload_hash &&
        createHash('sha256').update(attempt.input).digest('hex') !== frozenStep.payload_hash
      )
        return refuse('not dispatched: the input is not the approved payload', {
          status: 'blocked',
          disposition: 'payload_mismatch: the input is not the approved payload',
        })
    }
    // Refused dispatch generations: the person is needed at the lifetime limit; after five in a row the attempt waits.
    if (attempt.needs_person || (attempt.next_try_at !== null && attempt.next_try_at > now))
      return undefined
    // A coding step whose approved settings no longer match: it is suspended as it is (one attempt per step) and the
    // step waits for "Use the new settings" or a new approval (7.7b §12a). Nothing was sent.
    if (denial?.policy !== undefined && attempt.step_id) {
      sqlite
        .prepare('UPDATE orc_attempts SET suspended = 1, updated_at = ? WHERE id = ?')
        .run(now, attempt.id)
      setStepStatus(sqlite, o.id, attempt.step_id, 'blocked', 'agent_changed', now)
      addCause(sqlite, o.id, 'step_blocked', attempt.step_id, now, 'agent_changed')
      touch(ctx, o.id)
      return undefined
    }
    if (denial?.cause === 'agent_changed') {
      if (attempt.kind === 'lead') {
        refuseAttempt(
          sqlite,
          attempt,
          denial.frozenMapping
            ? 'not dispatched: the lead agent mapping changed'
            : 'not dispatched: the lead agent changed',
          now,
        )
        // Nothing was sent, so the turn's causes go back to the wake cursor.
        sqlite
          .prepare(
            'UPDATE orchestrations SET causes_consumed_up_to = ?, lead_turns_used = lead_turns_used - 1 WHERE id = ?',
          )
          .run(attempt.claim_from ?? 0, o.id)
        this.pauseFor(ctx, o, 'agent_unavailable')
        return undefined
      }
      return denial.frozenMapping
        ? refuse('not dispatched: not the approved agent mapping', {
            status: 'blocked',
            disposition: 'agent_changed: not the agent mapping approved for this run',
          })
        : refuse('not dispatched: the agent changed', {
            status: 'blocked',
            disposition: 'agent_unavailable: the agent was replaced or removed',
          })
    }
    // Pauses, fences, holds, the deadline and a stop owed: the attempt stays `created`. The deadline flow, the budget
    // pause and the unknown-cost pause are the orchestration's own.
    if (denial?.cause === 'budget' || denial?.cause === 'unknown_cost') {
      this.pauseFor(
        ctx,
        requireOrch(sqlite, o.id),
        denial.cause === 'budget' ? 'budget' : 'unknown_spend',
      )
      return undefined
    }
    if (denial) return undefined
    let capability: string | undefined
    // Dispatch generation g: 1, 2, ... for a step attempt (never reused, even after a journaled refusal); the lead's is
    // its capability generation.
    let generation =
      attempt.kind === 'step'
        ? Math.max(attempt.dispatch_generation, dispatched?.generation ?? 0) + 1
        : 0
    if (attempt.kind === 'lead') {
      capability = mintCapability()
      generation =
        (
          sqlite
            .prepare('SELECT COUNT(*) AS n FROM orc_capabilities WHERE attempt_id = ?')
            .get(attempt.id) as { n: number }
        ).n + 1
      // A re-dispatch never reuses an earlier capability: the older generations expire here.
      sqlite
        .prepare(
          'UPDATE orc_capabilities SET expired_at = ? WHERE attempt_id = ? AND expired_at IS NULL',
        )
        .run(now, attempt.id)
      sqlite
        .prepare(
          'INSERT INTO orc_capabilities (hash, attempt_id, generation, agent_id, agent_incarnation, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          hashCapability(capability),
          attempt.id,
          generation,
          attempt.agent_id,
          attempt.agent_incarnation,
          now,
        )
    }
    // A coding worker's generation has its own turn id and launch id, minted here and journaled with the send (7.7b §5).
    let coding: { generation: number; turnId: string; launchId: string } | undefined
    if (attempt.kind === 'step' && attempt.runtime !== 'hermes') {
      if (generation > MAX_GENERATIONS && o.planner === 'workflow' && attempt.step_id) {
        // A workflow node's dispatch held back 20 times waits for the person where it is (7.7c §4): the attempt is
        // suspended, the node keeps its step, and Try again renews it. It is never refused and replaced by the planner.
        sqlite
          .prepare('UPDATE orc_attempts SET suspended = 1, updated_at = ? WHERE id = ?')
          .run(now, attempt.id)
        setStepStatus(sqlite, o.id, attempt.step_id, 'blocked', 'held_back', now)
        touch(ctx, o.id)
        return undefined
      }
      if (generation > MAX_GENERATIONS) {
        // Held back again and again: the person decides, there is no automatic loop (design §5).
        refuseAttempt(sqlite, attempt, 'held_back_too_often', now)
        if (attempt.step_id) {
          setStepStatus(
            sqlite,
            o.id,
            attempt.step_id,
            'blocked',
            'kept being held back: it was prepared 20 times and never started',
            now,
          )
          addCause(sqlite, o.id, 'step_blocked', attempt.step_id, now, 'kept being held back')
        }
        touch(ctx, o.id)
        return undefined
      }
      coding = {
        generation,
        turnId: codingTurnId(attempt.turn_id, generation),
        launchId: randomUUID(),
      }
      this.openGeneration(ctx, attempt, coding)
    }
    sqlite
      .prepare(
        "UPDATE orc_attempts SET state = 'send_started', sent_at = ?, dispatch_generation = ?, next_try_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(now, generation, now, attempt.id)
    // Journal first (fsync'd) and last in the transaction: if it cannot be written the whole send is abandoned.
    ctx.journal.append({
      kind: 'send_started',
      attemptId: attempt.id,
      orchestrationId: o.id,
      attemptKind: attempt.kind,
      agentId: attempt.agent_id,
      generation,
      ...(coding ? { turnId: coding.turnId, launchId: coding.launchId } : {}),
    })
    touch(ctx, o.id)
    return {
      attempt: { ...attempt, state: 'send_started', dispatch_generation: generation },
      ...(capability ? { capability } : {}),
      ...(coding ? { coding } : {}),
    }
  },

  /** The generation's identity rows: its turn/launch ids and its own reply row (never the older generation's). */
  openGeneration(
    this: OrchestratorRuntime,
    ctx: Ctx,
    attempt: AttemptRow,
    coding: { generation: number; turnId: string; launchId: string },
  ): void {
    const { sqlite, now } = ctx
    const messageId = `reply:${coding.turnId}`
    sqlite
      .prepare(
        'INSERT INTO orc_generations (attempt_id, generation, turn_id, launch_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(attempt.id, coding.generation, coding.turnId, coding.launchId, messageId, now)
    // The first generation takes over the reply row insertAttempt reserved; later ones copy it, so every generation
    // streams into its own reply and the older one is only ever closed.
    const taken = sqlite
      .prepare(
        'UPDATE message_runs SET turn_id = ?, message_id = ?, generation = ? WHERE orchestration_attempt_id = ? AND generation IS NULL',
      )
      .run(coding.turnId, messageId, coding.generation, attempt.id)
    if (Number(taken.changes) === 0)
      sqlite
        .prepare(
          `INSERT INTO message_runs (message_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, created_at, orchestration_attempt_id, generation)
           SELECT ?, room_id, agent_id, chain_id, hop, ?, parent_message_id, input, agents, ?, orchestration_attempt_id, ?
           FROM message_runs WHERE orchestration_attempt_id = ? ORDER BY generation DESC LIMIT 1`,
        )
        .run(messageId, coding.turnId, now, coding.generation, attempt.id)
    sqlite.prepare('UPDATE orc_attempts SET message_id = ? WHERE id = ?').run(messageId, attempt.id)
  },

  recordHandle(
    this: OrchestratorRuntime,
    ctx: Ctx,
    attemptId: string,
    generation: number | null,
    runId: string,
  ): void {
    const { sqlite, now } = ctx
    const attempt = readAttempt(sqlite, attemptId)
    if (!attempt) return
    const o = requireOrch(sqlite, attempt.orchestration_id)
    if (generation !== null) {
      // The handle belongs to one generation: it is kept as that generation's evidence, and it attaches to the attempt
      // only while that generation is the current one (7.7b §5). An older generation's run is never reattached.
      sqlite
        .prepare(
          'UPDATE orc_generations SET run_id = COALESCE(run_id, ?) WHERE attempt_id = ? AND generation = ?',
        )
        .run(runId, attemptId, generation)
      journalSoft(ctx, () =>
        ctx.journal.append({ kind: 'run_handle', attemptId, runId, generation }),
      )
      if (
        attempt.dispatch_generation !== generation ||
        !['send_started', 'running'].includes(attempt.state)
      ) {
        touch(ctx, o.id)
        return
      }
    }
    sqlite
      .prepare(
        `UPDATE orc_attempts SET run_id = ?, state = CASE WHEN state = 'send_started' THEN 'running' ELSE state END, refused_streak = CASE WHEN ? = 1 THEN refused_streak ELSE 0 END, updated_at = ? WHERE id = ?`,
      )
      .run(runId, generation === null ? 0 : 1, now, attemptId)
    // A Stop (or finish of a non-requesting attempt) that raced the admission: the handle arrived late; stop it now.
    if (['stopping'].includes(o.status) || isTerminalStatus(o.status) || attempt.retired)
      sqlite
        .prepare(
          'UPDATE orc_attempts SET retired = 1, stop_requested_at = COALESCE(stop_requested_at, ?) WHERE id = ?',
        )
        .run(now, attemptId)
    if (generation === null)
      journalSoft(ctx, () => ctx.journal.append({ kind: 'run_handle', attemptId, runId }))
    touch(ctx, o.id)
  },
}

export type SendMethods = typeof sendMethods
