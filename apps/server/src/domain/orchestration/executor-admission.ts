import { ORCH_CAPACITY, ORC_CAPABILITY_PLACEHOLDER } from '@score/contract'
import { z } from 'zod'
import { agentAdmits, agentPausedAt, lifecycleOf } from '../agent-lifecycle.ts'
import { teamPausedAt } from '../team-pause.ts'
import { budgetView, canReserve, overBudget, unknownCostBlocks } from './budget.ts'
import { containsCapability } from './capability.ts'
import { touch, type Ctx } from './ctx.ts'
import { isFenced } from './fence.ts'
import { readWorkerPolicy } from './coding-policy.ts'
import { recoveredOnly } from './admission.ts'
import { quotaAdmits } from './quota-guard.ts'
import { getCodingAgent } from '../../runtimes/coding/store.ts'
import { runtimeOfAgent } from './coding-attempts.ts'
import {
  activeStepCounts,
  addStored,
  addCodingStored,
  codingUnsentSlots,
  setStepStatus,
} from './ops.ts'
import { renderLeadInput, renderStepInput } from './render.ts'
import {
  effectiveSize,
  helperLines,
  stepVotePending,
  helpersOf,
  usesHelperSlot,
} from './helpers.ts'
import { agentAdvisorModel } from './advisor.ts'
import {
  addCause,
  addHistory,
  attemptsOf,
  causesAfter,
  frozenIncarnation,
  gatesOf,
  inquiriesOf,
  leadOf,
  listOrchs,
  readOrch,
  stepsOf,
  type OrchRow,
} from './store.ts'
import { cancelFenceAttempts, unknownFenceAttempts } from './views.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'

export const admissionMethods = {
  /**
   * The one admission authority. Creates attempts in `created` (a lead attempt claims the wake cursor and freezes its
   * input; a step transfers its reservation); sending them is `dispatch`, which re-checks everything.
   */
  admit(this: OrchestratorRuntime, ctx: Ctx): string[] {
    const { sqlite } = ctx
    // A frozen home (unresolved or copied installation, lost journal) dispatches nothing (decision 71).
    if (isFenced(sqlite) || this.options.fence.executionFrozenIn(sqlite) !== null) return []
    const counts = activeStepCounts(sqlite)
    for (const o of listOrchs(sqlite).reverse()) {
      // The manual hold is checked on its own, whatever the status says (fix-i 3).
      if (o.status !== 'running' || o.manual_paused_at !== null) continue
      if ((this.cooldown.get(o.id) ?? 0) > this.nowMs()) continue
      this.admitRun(ctx, o, counts)
    }
    // Everything admitted and not yet sent, including attempts that waited out a pause or a fence.
    return z
      .array(z.object({ id: z.string(), orchestration_id: z.string() }))
      .parse(
        sqlite
          .prepare(
            `SELECT a.id, a.orchestration_id FROM orc_attempts a JOIN orchestrations o ON o.id = a.orchestration_id
             WHERE a.state = 'created' AND a.suspended = 0 AND o.status IN ('running', 'stopping', 'finishing') ORDER BY a.created_at, a.rowid`,
          )
          .all(),
      )
      .filter((row) => (this.cooldown.get(row.orchestration_id) ?? 0) <= this.nowMs())
      .map((row) => row.id)
  },

  admitRun(
    this: OrchestratorRuntime,
    ctx: Ctx,
    o: OrchRow,
    counts: ReturnType<typeof activeStepCounts>,
  ): void {
    const { sqlite, now } = ctx
    const attempts = attemptsOf(sqlite, o.id)
    if (unknownFenceAttempts(o, attempts).length > 0 || cancelFenceAttempts(o, attempts).length > 0)
      return
    if (o.deadline_at !== null && now >= o.deadline_at) return
    const view = budgetView(sqlite, o)
    if (overBudget(view)) return this.pauseFor(ctx, o, 'budget')
    if (unknownCostBlocks(sqlite, o, view)) return this.pauseFor(ctx, o, 'unknown_spend')
    if (teamPausedAt(sqlite) !== null) return

    const steps = stepsOf(sqlite, o.id)
    let leadLive = attempts.some(
      (a) => a.kind === 'lead' && ['created', 'send_started', 'running'].includes(a.state),
    )
    const pending = causesAfter(sqlite, o.id, o.causes_consumed_up_to)
    if (o.planner === 'lead' && !leadLive && pending.length > 0) {
      const lead = leadOf(o)
      const life = lifecycleOf(sqlite, lead.agentId)
      const incarnation = life?.incarnation_id ?? 'untracked'
      if (incarnation !== lead.incarnation || !agentAdmits(sqlite, lead.agentId))
        return this.pauseFor(ctx, o, 'agent_unavailable')
      if (o.until_stopped !== 1 && o.lead_turns_used >= o.max_lead_turns)
        return this.pauseFor(ctx, o, 'turns_exhausted')
      if (o.consecutive_lead_failures >= 2) return this.pauseFor(ctx, o, 'lead_failing')
      if (!canReserve(view, o.lead_turn_estimate_usd)) return this.pauseFor(ctx, o, 'budget')
      if (agentPausedAt(sqlite, lead.agentId) === null) {
        const turn = o.lead_turns_used + 1
        const n = attempts.filter((a) => a.kind === 'lead').length + 1
        const attemptId = `orc-${o.id.slice(4)}-lead-${n}`
        const claimTo = pending.at(-1)!.id
        const input = renderLeadInput({
          o: { ...o, lead_turns_used: turn },
          turn,
          steps,
          gates: gatesOf(sqlite, o.id),
          inquiries: inquiriesOf(sqlite, o.id),
          causes: pending,
          budget: view,
          now,
          check: this.leadCheck(sqlite, o.id),
          helperLines: helperLines(sqlite, o),
        })
        if (!input.includes(ORC_CAPABILITY_PLACEHOLDER))
          throw new Error('Lead input lost its capability placeholder')
        this.insertAttempt(ctx, o, {
          id: attemptId,
          kind: 'lead',
          stepId: null,
          n,
          agentId: lead.agentId,
          incarnation,
          input,
          reserved: o.lead_turn_estimate_usd,
          claim: { from: o.causes_consumed_up_to, to: claimTo },
        })
        sqlite
          .prepare(
            'UPDATE orchestrations SET causes_consumed_up_to = ?, lead_turns_used = lead_turns_used + 1 WHERE id = ?',
          )
          .run(claimTo, o.id)
        addStored(sqlite, o.id, Buffer.byteLength(input))
        leadLive = true
        touch(ctx, o.id)
      }
    }
    const byId = new Map(steps.map((s) => [s.id, s]))
    // Coding attempts that are prepared and not finished (waiting, in flight or blocked for a decision) keep their frozen
    // input; their number is bounded apart from the launch limit, and the in-flight ones count so a burst can't exceed it.
    let unsentCoding = attempts.filter(
      (a) =>
        a.kind === 'step' &&
        a.runtime !== 'hermes' &&
        ['created', 'send_started', 'running', 'unknown'].includes(a.state),
    ).length
    for (const step of steps) {
      if (step.status !== 'queued') continue
      // 3.14: a step the voters are still judging waits for their tally.
      if (stepVotePending(sqlite, o.id, step.id)) continue
      // A lead-asks step waits until the turn that created it ends, so the lead can ask for approval first.
      if (o.gate_policy === 'lead-asks' && leadLive) continue
      if (!step.after_steps.every((id) => byId.get(id)?.status === 'succeeded')) continue
      // A result that only ever ended on recovered text is history, never an input (fix-i 2).
      if (step.after_steps.some((id) => recoveredOnly(attempts, id))) continue
      const life = lifecycleOf(sqlite, step.agent_id)
      if ((life?.incarnation_id ?? 'untracked') !== step.agent_incarnation) {
        setStepStatus(
          sqlite,
          o.id,
          step.id,
          'blocked',
          'agent_unavailable: the agent was replaced or removed',
          now,
        )
        addCause(sqlite, o.id, 'step_blocked', step.id, now, 'agent_unavailable')
        touch(ctx, o.id)
        continue
      }
      // The step must also match the mapping the person started (or remapped) the run with.
      const frozen = frozenIncarnation(sqlite, o.id, step.agent_id)
      if (frozen !== undefined && frozen !== step.agent_incarnation) {
        setStepStatus(
          sqlite,
          o.id,
          step.id,
          'blocked',
          'agent_changed: not the agent mapping approved for this run',
          now,
        )
        addCause(sqlite, o.id, 'step_blocked', step.id, now, 'agent_changed')
        touch(ctx, o.id)
        continue
      }
      if (!agentAdmits(sqlite, step.agent_id) || agentPausedAt(sqlite, step.agent_id) !== null)
        continue
      // 3.15: helper work and vote answers have their own slots; the lead's limit is for its own steps.
      const helperConfig = usesHelperSlot(step) ? helpersOf(o) : null
      const slot = helperConfig ? `${o.id}#helpers` : o.id
      if ((counts.perRun.get(slot) ?? 0) >= (helperConfig?.maxConcurrent ?? o.max_concurrent_steps))
        continue
      if (counts.total >= ORCH_CAPACITY.concurrentSteps) continue
      if ((counts.perAgent.get(step.agent_id) ?? 0) >= ORCH_CAPACITY.stepsPerAgent) continue
      // The quota guard (8.6): a coding agent below its floor takes no new step; the step is held and the person asked.
      // Missing or expired readings never hold; a step that already runs is never touched.
      if (!quotaAdmits(ctx, this.options.codingFacts?.quota, o, step)) {
        this.wakeAtReset(ctx, o.id, step.id)
        continue
      }
      const dependencies = step.after_steps.map((id) => byId.get(id)!)
      // A workflow step's instruction already is the final, validated payload (it is never re-rendered or clipped).
      // 3.14.1: a worker with its own advisor (a Claude Code agent's setting) is reminded when to ask it.
      const input =
        o.planner === 'workflow'
          ? step.instruction
          : renderStepInput({
              o,
              step,
              dependencies,
              advisorOnCall: !step.role && agentAdvisorModel(sqlite, step.agent_id) !== null,
            })
      // Scanned after rendering and before anything is stored: a capability in a step input blocks admission.
      if (containsCapability(input) || containsCapability(step.instruction)) {
        setStepStatus(sqlite, o.id, step.id, 'blocked', 'capability_in_input', now)
        addCause(sqlite, o.id, 'step_blocked', step.id, now, 'capability_in_input')
        touch(ctx, o.id)
        continue
      }
      // A step that was blocked with a suspended attempt (agent changed, limit reached) goes on with that SAME attempt:
      // one active attempt per step, its reservation and frozen input kept (7.7b §12a). It is admitted again through the
      // same rules; its policy id is the one the step is approved for now.
      const suspended = attempts.findLast((a) => a.step_id === step.id && a.suspended)
      if (suspended) {
        sqlite
          .prepare(
            'UPDATE orc_attempts SET suspended = 0, policy_id = ?, updated_at = ? WHERE id = ?',
          )
          .run(
            // The step keeps the settings it was approved with (set at its own remap); the worker's stored mapping may
            // have moved on for another step, and admission then blocks this one until it is remapped itself (F2 #3).
            suspended.policy_id ?? readWorkerPolicy(sqlite, o.id, step.agent_id)?.policyId ?? null,
            now,
            suspended.id,
          )
        setStepStatus(sqlite, o.id, step.id, 'admitted', null, now)
        counts.perRun.set(slot, (counts.perRun.get(slot) ?? 0) + 1)
        counts.perAgent.set(step.agent_id, (counts.perAgent.get(step.agent_id) ?? 0) + 1)
        counts.total++
        touch(ctx, o.id)
        continue
      }
      // A coding step is parked, with nothing prepared or retained, while the run's room for unsent inputs is used up (the
      // slots, or the partition's bytes): it goes on when an attempt is sent or settled, or the person raises the limit
      // that grows the partition (7.7c F1 #6). Retaining it anyway would spill into the control reserve.
      const codingStep = runtimeOfAgent(sqlite, step.agent_id) !== 'hermes'
      if (codingStep) {
        const fresh = readOrch(sqlite, o.id) ?? o
        if (
          unsentCoding >= codingUnsentSlots(effectiveSize(o).steps, effectiveSize(o).concurrent) ||
          fresh.coding_stored_bytes + Buffer.byteLength(input) > fresh.coding_reserve_bytes
        )
          continue
        unsentCoding++
      }
      const n = attempts.filter((a) => a.step_id === step.id).length + 1
      const attemptId = `orc-${o.id.slice(4)}-${step.id}-${n}`
      this.insertAttempt(ctx, o, {
        id: attemptId,
        kind: 'step',
        stepId: step.id,
        n,
        agentId: step.agent_id,
        incarnation: step.agent_incarnation,
        input,
        reserved: step.estimate_usd,
        claim: null,
      })
      addHistory(
        sqlite,
        o.id,
        'step_input_frozen',
        {
          attemptId,
          revisions: Object.fromEntries(dependencies.map((d) => [d.id, d.result_revision])),
        },
        now,
      )
      setStepStatus(sqlite, o.id, step.id, 'admitted', null, now)
      // A workflow step's input also lives in its reply row and its dispatch intent: every retained copy is charged.
      if (codingStep) addCodingStored(sqlite, o.id, Buffer.byteLength(input))
      else addStored(sqlite, o.id, Buffer.byteLength(input) * (o.planner === 'workflow' ? 3 : 1))
      counts.perRun.set(slot, (counts.perRun.get(slot) ?? 0) + 1)
      counts.perAgent.set(step.agent_id, (counts.perAgent.get(step.agent_id) ?? 0) + 1)
      counts.total++
      touch(ctx, o.id)
    }
  },

  /** Antigravity's quota is read from its CLI: refresh it (at most once a minute) when a queued step would use it. */
  refreshQuota(this: OrchestratorRuntime): Promise<unknown> | undefined {
    const quota = this.options.codingFacts?.quota
    if (!quota) return undefined
    const needed = this.db.read((sqlite) =>
      listOrchs(sqlite).some(
        (o) =>
          o.status === 'running' &&
          stepsOf(sqlite, o.id).some(
            (step) =>
              step.status === 'queued' &&
              getCodingAgent(sqlite, step.agent_id)?.runtime === 'antigravity',
          ),
      ),
    )
    return needed ? quota.refresh().catch(() => undefined) : undefined
  },
}

export type AdmissionMethods = typeof admissionMethods
