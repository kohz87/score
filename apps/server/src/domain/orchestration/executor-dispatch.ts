import { runJobScope } from './subagent-scope.ts'
import { withCapability } from './capability.ts'
import { type Ctx } from './ctx.ts'
import { readWorkerPolicy } from './coding-policy.ts'
import { holdOf } from './quota-guard.ts'
import { type OrchestrationOwner } from './owner.ts'
import { insertAttemptRows, type NewAttempt } from './attempt-rows.ts'
import { readOrch, type AttemptRow, type OrchRow } from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'

export const dispatchMethods = {
  insertAttempt(this: OrchestratorRuntime, ctx: Ctx, o: OrchRow, a: NewAttempt): void {
    insertAttemptRows(ctx, o, a)
  },

  // ---------------------------------------------------------------------------------------------------- dispatch

  /**
   * Sends one admitted attempt. The transaction that starts the send re-checks every admission rule, mints the
   * capability (lead attempts), and journals `send_started` before it commits; only then is Hermes called. After this
   * point the admission is never replayed: any uncertainty makes the attempt `unknown`.
   */
  async dispatch(this: OrchestratorRuntime, attemptId: string): Promise<boolean> {
    let begun:
      | {
          attempt: AttemptRow
          capability?: string
          coding?: { generation: number; turnId: string; launchId: string }
        }
      | undefined
    try {
      begun = await this.mutate((ctx) => this.beginSend(ctx, attemptId))
    } catch (error) {
      // The journal could not record the send, so nothing was sent: fence rather than act without a record.
      this.err(error)
      this.fenceNow('journal_unwritable', error instanceof Error ? error.message : String(error))
      return false
    }
    if (!begun) return false
    const { attempt, capability, coding } = begun
    try {
      const result = await this.options.port.startRun({
        agentId: attempt.agent_id,
        input: attempt.input,
        turnId: coding?.turnId ?? attempt.turn_id,
        sessionId: attempt.session_id,
        ...runJobScope(this.options.db.sqlite, attempt.orchestration_id),
        owner: coding ? this.ownerOf(attempt, coding) : 'orchestration',
        ...(capability ? { render: (stored: string) => withCapability(stored, capability) } : {}),
      })
      await this.mutate((ctx) =>
        this.recordHandle(ctx, attempt.id, coding?.generation ?? null, result.runId),
      )
    } catch (error) {
      await this.mutate((ctx) =>
        this.recordSendFailure(ctx, attempt.id, error, coding?.generation ?? null),
      )
    }
    return true
  },

  /** The owner a coding launch carries: its generation's identity and the executor's decision at the ordering point. */
  ownerOf(
    this: OrchestratorRuntime,
    attempt: AttemptRow,
    coding: { generation: number; launchId: string },
  ): OrchestrationOwner {
    const { deadline, policy } = this.db.read((sqlite) => ({
      deadline: readOrch(sqlite, attempt.orchestration_id)?.deadline_at ?? null,
      policy: readWorkerPolicy(sqlite, attempt.orchestration_id, attempt.agent_id),
    }))
    return {
      kind: 'orchestration',
      orchestrationId: attempt.orchestration_id,
      attemptId: attempt.id,
      generation: coding.generation,
      launchId: coding.launchId,
      deadlineAt: deadline === null ? null : Date.parse(deadline),
      // The invocation is built from this stored policy, never from the live agent row (7.7b §3).
      ...(policy ? { policy: { id: policy.policyId, policy: policy.policy } } : {}),
      // Its own read transaction, inside the release critical section. Never writes, never awaits (design §6).
      authorise: (prepared, journal) =>
        this.db.read((sqlite) =>
          this.decideRelease(sqlite, {
            orchestrationId: attempt.orchestration_id,
            attemptId: attempt.id,
            generation: coding.generation,
            launchId: coding.launchId,
            expiry: prepared.expiry,
            policyId: prepared.policyId,
            executed: journal.executedBy(attempt.orchestration_id),
          }),
        ),
    }
  },

  wakeAtReset(this: OrchestratorRuntime, ctx: Ctx, orchId: string, stepId: string): void {
    const hold = holdOf(ctx.sqlite, orchId, stepId)
    if (hold?.state !== 'waiting') return
    const key = `${orchId}:${stepId}:${hold.resets_at}`
    if (this.resetWakes.has(key)) return
    this.resetWakes.add(key)
    const delay = Math.max(0, Date.parse(hold.resets_at) - Date.parse(ctx.now))
    this.wakeAfter(Math.min(delay + 50, 2_000_000_000))
  },

  /** A pump after a pause, so a held-back attempt is tried again without waiting for the next sweep. */
  wakeAfter(this: OrchestratorRuntime, ms: number): void {
    const timer = setTimeout(() => this.kick(), ms + 5)
    timer.unref()
  },
}

export type DispatchMethods = typeof dispatchMethods
