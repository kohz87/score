import { ORCH_CAPACITY, type WaitingFor } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { agentAdmits, agentPausedAt } from '../agent-lifecycle.ts'
import { budgetView, canReserve, unknownCostBlocks } from '../orchestration/budget.ts'
import { isFenced } from '../orchestration/fence.ts'
import { activeStepCounts, codingUnsentSlots } from '../orchestration/ops.ts'
import { runtimeOfAgent } from '../orchestration/coding-attempts.ts'
import { holdsOf } from '../orchestration/quota-guard.ts'
import {
  isTerminalStatus,
  type AttemptRow,
  type OrchRow,
  type StepRow,
} from '../orchestration/store.ts'
import { teamPausedAt } from '../team-pause.ts'
import { assignWait } from './planner.ts'
import { type WfNodeRow, type WfRunRow } from './store.ts'

// ---------------------------------------------------------------------------------------------------- waiting

export function waitingFor(
  sqlite: DatabaseSync,
  o: OrchRow,
  wf: WfRunRow,
  node: WfNodeRow,
  step: StepRow | undefined,
  attempt: AttemptRow | undefined,
  now: string,
  counts: ReturnType<typeof activeStepCounts>,
  unsentCoding: number,
): WaitingFor | null {
  if (isTerminalStatus(o.status) || node.kind !== 'agent') return null
  const def = wf.definition.nodes.find((n) => n.id === node.node_id)
  if (!def || def.kind !== 'agent') return null
  if (node.state === 'ready') {
    const wait = assignWait(sqlite, o, wf, def.agentId)
    if (wait) return wait
    if (!canReserve(budgetView(sqlite, o), def.estimateUsd ?? o.step_estimate_usd)) return 'budget'
    return null
  }
  if (!['running'].includes(node.state) || !step) return null
  // 7.7c: a coding step blocked for a decision keeps its place and says what it waits for.
  if (step.status === 'blocked' && attempt?.suspended)
    return step.disposition === 'coding_limit'
      ? 'coding_limit'
      : step.disposition === 'held_back'
        ? 'held_back'
        : 'coding_settings'
  if (attempt?.needs_person) return 'refusal_limit'
  if (
    ['queued', 'pending_gate'].includes(step.status) &&
    holdsOf(sqlite, o.id).some((hold) => hold.step_id === step.id && hold.state !== 'override')
  )
    return 'quota_low'
  if (attempt && attempt.state === 'created' && attempt.next_try_at && attempt.next_try_at > now)
    return 'hermes_unavailable'
  if (!['queued', 'admitted'].includes(step.status)) return null
  if (attempt && attempt.state !== 'created') return null
  if (o.status === 'paused' || o.manual_paused_at !== null) return 'run_hold'
  if (isFenced(sqlite)) return 'fence'
  if (teamPausedAt(sqlite) !== null || agentPausedAt(sqlite, step.agent_id) !== null)
    return 'agent_hold'
  if (!agentAdmits(sqlite, step.agent_id)) return 'agent_unavailable'
  const view = budgetView(sqlite, o)
  if (unknownCostBlocks(sqlite, o, view)) return 'unknown_spend'
  if (!attempt) {
    if (
      (counts.perRun.get(o.id) ?? 0) >= o.max_concurrent_steps ||
      counts.total >= ORCH_CAPACITY.concurrentSteps
    )
      return 'capacity'
    if ((counts.perAgent.get(step.agent_id) ?? 0) >= ORCH_CAPACITY.stepsPerAgent)
      return 'agent_capacity'
    // Admission parks a coding step while the run's room for unsent coding inputs is used up (executor.ts, same rule).
    if (
      runtimeOfAgent(sqlite, step.agent_id) !== 'hermes' &&
      (unsentCoding >= codingUnsentSlots(o.max_steps, o.max_concurrent_steps) ||
        o.coding_stored_bytes + Buffer.byteLength(step.instruction) > o.coding_reserve_bytes)
    )
      return 'coding_room'
  }
  return null
}
