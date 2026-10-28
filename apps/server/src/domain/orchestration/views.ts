import type {
  AttemptView,
  GateView,
  InquiryView,
  NeedsYou,
  OrchestrationDetail,
  OrchestrationSummary,
  OwnershipState,
  StepView,
} from '@score/contract'
import { checkView } from './checks.ts'
import { consultViews, workerAdvisorAsks } from './advisor.ts'
import { helpersView } from './helpers.ts'
import type { DatabaseSync } from 'node:sqlite'
import { workerPoliciesOf } from './coding-policy.ts'
import { lifecycleOf } from '../agent-lifecycle.ts'
import { budgetView } from './budget.ts'
import { isFenced } from './fence.ts'
import { holdView, holdsOf, type HoldRow } from './quota-guard.ts'
import {
  attemptsOf,
  gatesOf,
  inquiriesOf,
  isFinalStep,
  isTerminalStatus,
  leadOf,
  stepsOf,
  type AttemptRow,
  type GateRow,
  type OrchRow,
  type StepRow,
} from './store.ts'

// Read models: everything the browser sees is built here from rows, so the contract mapping lives in one place.

/** Attempts holding a Stop that Hermes has not acknowledged, or whose end is not confirmed. */
export function openObligations(attempts: AttemptRow[]): AttemptRow[] {
  return attempts.filter(
    (attempt) =>
      (attempt.state === 'unknown' && attempt.abandoned_at === null) ||
      (attempt.stop_requested_at !== null &&
        attempt.stop_acknowledged_at === null &&
        ['send_started', 'running', 'unknown', 'abandoned'].includes(attempt.state)),
  )
}

export function ownershipOf(o: OrchRow, attempts: AttemptRow[]): OwnershipState {
  if (!isTerminalStatus(o.status)) return 'owned'
  return openObligations(attempts).length > 0 ? 'draining' : 'released'
}

/** Cancelled-but-possibly-running attempts: the whole run admits nothing until they end, are abandoned or waived. */
export function cancelFenceAttempts(o: OrchRow, attempts: AttemptRow[]): AttemptRow[] {
  return attempts.filter(
    (attempt) =>
      attempt.retired &&
      attempt.kind === 'step' &&
      ['send_started', 'running', 'unknown'].includes(attempt.state) &&
      !(
        o.waiver_at !== null &&
        attempt.stop_requested_at !== null &&
        attempt.stop_requested_at <= o.waiver_at
      ),
  )
}

/** Attempts of unknown fate that fence admission (retired ones are covered by the cancel fence and its waiver). */
export function unknownFenceAttempts(o: OrchRow, attempts: AttemptRow[]): AttemptRow[] {
  return attempts.filter(
    (attempt) =>
      attempt.state === 'unknown' &&
      attempt.abandoned_at === null &&
      !(
        attempt.retired &&
        o.waiver_at !== null &&
        attempt.stop_requested_at !== null &&
        attempt.stop_requested_at <= o.waiver_at
      ),
  )
}

const stepGates = (gates: GateRow[], stepId: string): GateRow | undefined =>
  gates.findLast((gate) => gate.step_id === stepId && gate.status !== 'withdrawn') ??
  gates.findLast((gate) => gate.step_id === stepId)

export function needsYouOf(
  sqlite: DatabaseSync,
  o: OrchRow,
  gates: GateRow[],
  attempts: AttemptRow[],
  inquiries: ReturnType<typeof inquiriesOf>,
): NeedsYou[] {
  const result: NeedsYou[] = []
  for (const gate of gates)
    if (gate.status === 'open') result.push({ kind: 'gate', gateId: gate.id, stepId: gate.step_id })
  for (const inquiry of inquiries)
    if (inquiry.status === 'open') result.push({ kind: 'inquiry', inquiryId: inquiry.id })
  if (o.status === 'paused' && o.pause_reason !== null) {
    const reason = o.pause_reason as Extract<NeedsYou, { kind: 'paused' }>['reason']
    if (reason !== 'person')
      result.push(
        ['budget', 'unknown_spend', 'deadline'].includes(reason)
          ? { kind: 'budget', reason }
          : { kind: 'paused', reason },
      )
  }
  for (const attempt of unknownFenceAttempts(o, attempts))
    result.push({ kind: 'unknown', attemptId: attempt.id })
  for (const attempt of cancelFenceAttempts(o, attempts))
    result.push({ kind: 'cancel_fence', stepId: attempt.step_id ?? '', attemptId: attempt.id })
  if (!isTerminalStatus(o.status) && isFenced(sqlite))
    result.push({ kind: 'fence', reason: 'global' })
  if (!isTerminalStatus(o.status) && o.status !== 'stopping' && o.status !== 'finishing') {
    // 7.7b: a coding step blocked with its suspended attempt waits for a decision of the person.
    const suspended = new Set(
      attempts.filter((a) => a.suspended && a.step_id !== null).map((a) => a.step_id),
    )
    for (const step of stepsOf(sqlite, o.id)) {
      if (step.status !== 'blocked' || !suspended.has(step.id)) continue
      if (step.disposition === 'agent_changed' || step.disposition === 'permission_forbidden')
        result.push({
          kind: 'policy_changed',
          stepId: step.id,
          agentId: step.agent_id,
          currentPolicyId: null,
        })
      else if (step.disposition === 'coding_limit')
        result.push({ kind: 'coding_limit', stepId: step.id })
    }
    // 8.6: a step held because its coding agent is below its quota floor asks for one of three answers. A hold the
    // person already answered (waiting, override) asks nothing.
    const holds = holdsOf(sqlite, o.id)
    for (const step of stepsOf(sqlite, o.id)) {
      const hold = holds.find((row) => row.step_id === step.id)
      if (!hold || hold.state !== 'held' || !['queued', 'pending_gate'].includes(step.status))
        continue
      result.push({
        kind: 'quota_low',
        stepId: step.id,
        agentId: hold.agent_id,
        window: hold.window,
        group: hold.group_name,
        leftPercent: hold.left_percent,
        resetsAt: hold.resets_at,
      })
    }
    const mapped = sqlite
      .prepare(
        'SELECT agent_id, role, incarnation FROM orc_agent_map WHERE orchestration_id = ? ORDER BY role DESC, agent_id',
      )
      .all(o.id) as { agent_id: string; role: 'lead' | 'agent'; incarnation: string }[]
    for (const row of mapped) {
      const current = lifecycleOf(sqlite, row.agent_id)?.incarnation_id ?? 'untracked'
      if (current !== row.incarnation)
        result.push({
          kind: 'remap',
          agentId: row.agent_id,
          role: row.role,
          frozenIncarnation: row.incarnation,
          currentIncarnation: current,
        })
    }
  }
  return result
}

export function summaryOf(sqlite: DatabaseSync, o: OrchRow): OrchestrationSummary {
  const steps = stepsOf(sqlite, o.id)
  const attempts = attemptsOf(sqlite, o.id)
  const gates = gatesOf(sqlite, o.id)
  const inquiries = inquiriesOf(sqlite, o.id)
  return {
    id: o.id,
    title: o.title,
    status: o.status,
    pauseReason:
      o.status === 'paused' ? (o.pause_reason as OrchestrationSummary['pauseReason']) : null,
    leadAgentId: leadOf(o).agentId,
    roomId: o.room_id,
    briefId: o.brief_id,
    gatePolicy: o.gate_policy,
    revision: o.revision,
    ownership: ownershipOf(o, attempts),
    steps: {
      total: steps.length,
      active: steps.filter((s) =>
        ['pending_gate', 'queued', 'admitted', 'unknown'].includes(s.status),
      ).length,
      succeeded: steps.filter((s) => s.status === 'succeeded').length,
      failed: steps.filter((s) => ['failed', 'blocked', 'rejected'].includes(s.status)).length,
    },
    leadTurnsUsed: o.lead_turns_used,
    maxLeadTurns: o.max_lead_turns,
    needsYou: needsYouOf(sqlite, o, gates, attempts, inquiries),
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    endedAt: o.ended_at,
  }
}

export const attemptViewOf = (a: AttemptRow): AttemptView => ({
  id: a.id,
  kind: a.kind,
  stepId: a.step_id,
  n: a.n,
  agentId: a.agent_id,
  sessionId: a.session_id,
  state: a.state,
  runId: a.run_id,
  retired: a.retired,
  stopRequestedAt: a.stop_requested_at,
  stopAcknowledgedAt: a.stop_acknowledged_at,
  terminatedAt: a.terminated_at,
  evidence: a.evidence,
  unknownReason: a.unknown_reason,
  spendUsd: a.spend_usd,
  spendComplete: a.spend_complete,
  abandonedAt: a.abandoned_at,
})

export function gateView(g: GateRow): GateView {
  return {
    id: g.id,
    stepId: g.step_id,
    requestedBy: g.requested_by,
    status: g.status,
    payload: JSON.parse(g.payload) as GateView['payload'],
    payloadHash: g.payload_hash,
    revision: g.revision,
    note: g.note,
    createdAt: g.created_at,
    decidedAt: g.decided_at,
  }
}

export const stepViewOf = (
  s: StepRow,
  gates: GateRow[],
  attempts: AttemptRow[],
  holds: HoldRow[] = [],
  activity: ReadonlyMap<string, string> = new Map(),
): StepView => ({
  id: s.id,
  agentId: s.agent_id,
  instruction: s.instruction,
  after: s.after_steps,
  replaces: s.replaces,
  status: s.status,
  disposition: s.disposition,
  estimateUsd: s.estimate_usd,
  result: s.result,
  resultRevision: s.result_revision,
  gateId: stepGates(gates, s.id)?.id ?? null,
  attemptId: attempts.findLast((a) => a.step_id === s.id)?.id ?? null,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
  quotaHold: quotaHoldOf(s, holds),
  role: s.role ?? null,
  lastActivityAt: (() => {
    const runId = attempts.findLast((a) => a.step_id === s.id)?.run_id
    return runId ? (activity.get(runId) ?? null) : null
  })(),
  helperRole: s.helper_role ?? null,
})

/** A step that hasn't started and has a hold row shows it; a started or finished step never does. */
function quotaHoldOf(s: StepRow, holds: HoldRow[]): StepView['quotaHold'] {
  if (!['queued', 'pending_gate'].includes(s.status)) return null
  const row = holds.find((hold) => hold.step_id === s.id)
  return row ? holdView(row) : null
}

export function detailOf(sqlite: DatabaseSync, o: OrchRow): OrchestrationDetail {
  const steps = stepsOf(sqlite, o.id)
  const attempts = attemptsOf(sqlite, o.id)
  const gates = gatesOf(sqlite, o.id)
  const inquiries = inquiriesOf(sqlite, o.id)
  const inquiryViews: InquiryView[] = inquiries.map((q) => ({
    id: q.id,
    question: q.question,
    status: q.status,
    answer: q.answer,
    revision: q.revision,
    createdAt: q.created_at,
    answeredAt: q.answered_at,
  }))
  return {
    ...summaryOf(sqlite, o),
    goal: o.goal,
    allowedAgents: o.allowed_agents,
    plan: o.plan,
    maxSteps: o.max_steps,
    maxConcurrentSteps: o.max_concurrent_steps,
    deadlineAt: o.deadline_at,
    leadTurnEstimateUsd: o.lead_turn_estimate_usd,
    stepEstimateUsd: o.step_estimate_usd,
    budget: budgetView(sqlite, o),
    stepsList: (() => {
      const activity = runActivity(sqlite, attempts)
      const holds = holdsOf(sqlite, o.id)
      return steps.map((s) => stepViewOf(s, gates, attempts, holds, activity))
    })(),
    attempts: attempts.map(attemptViewOf),
    gates: gates.map(gateView),
    inquiries: inquiryViews,
    finish:
      o.finish_requested_at && o.finish_outcome
        ? {
            requestedAt: o.finish_requested_at,
            outcome: o.finish_outcome,
            summary: o.finish_summary ?? '',
          }
        : null,
    unconfirmed: openObligations(attempts).map((a) => a.id),
    cancelFence: cancelFenceAttempts(o, attempts).map((a) => ({
      stepId: a.step_id ?? '',
      attemptId: a.id,
    })),
    waiverAt: o.waiver_at,
    acknowledgedAt: (JSON.parse(o.acknowledgement) as { at: string }).at,
    endReason: o.end_reason,
    storage: { reserveBytes: o.reserve_bytes, storedBytes: o.stored_bytes },
    quotaFloorPercent: o.quota_floor_percent,
    check: checkView(sqlite, o.id),
    advisor: consultViews(sqlite, o),
    workerAdvisorAsks: workerAdvisorAsks(sqlite, o.id),
    helpers: helpersView(sqlite, o),
    coding: {
      stepLimit: o.coding_steps,
      acceptedUnknownCost: o.accepted_unknown_cost.filter(
        (source): source is 'hermes' | 'claude-code' | 'codex' =>
          source === 'hermes' || source === 'claude-code' || source === 'codex',
      ),
      workers: workerPoliciesOf(sqlite, o.id).map((stored) => ({
        agentId: stored.agentId,
        runtime: stored.policy.runtime as 'claude-code' | 'codex',
        policyId: stored.policyId,
        reach: stored.reach,
        reachBeyondWorkspace: stored.reachBeyondWorkspace,
      })),
    },
  }
}

export { isFinalStep }

/** When each run of these attempts last changed (its latest event), for the stuck-step view (3.14). */
function runActivity(sqlite: DatabaseSync, attempts: readonly AttemptRow[]): Map<string, string> {
  const ids = attempts.flatMap((a) => (a.run_id ? [a.run_id] : []))
  if (ids.length === 0) return new Map()
  const rows = sqlite
    .prepare(`SELECT id, updated_at FROM runs WHERE id IN (${ids.map(() => '?').join(', ')})`)
    .all(...ids) as { id: string; updated_at: string }[]
  return new Map(rows.map((row) => [row.id, row.updated_at]))
}
