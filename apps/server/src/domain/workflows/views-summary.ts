import {
  WORKFLOW_LIMITS,
  type WorkflowCodingBlock,
  type WorkflowNeedsYou,
  type WorkflowRunSummary,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { lifecycleOf } from '../agent-lifecycle.ts'
import { readWorkerPolicy, workerPoliciesOf } from '../orchestration/coding-policy.ts'
import type { CodingWorkerFacts } from '../orchestration/supported-agents.ts'
import type { WorkerPolicy } from '../../runtimes/coding/policy.ts'
import { isFenced } from '../orchestration/fence.ts'
import { holdsOf } from '../orchestration/quota-guard.ts'
import {
  attemptsOf,
  gatesOf,
  isTerminalStatus,
  stepsOf,
  type AttemptRow,
  type OrchRow,
} from '../orchestration/store.ts'
import { cancelFenceAttempts, ownershipOf, unknownFenceAttempts } from '../orchestration/views.ts'
import type { ExecutionJournal } from '../orchestration/journal.ts'
import { remapPlan } from './views-remap.ts'
import {
  nodesOf,
  requireWfRun,
  wfGatesOf,
  wfStepsOf,
  type WfNodeRow,
  type WfRunRow,
} from './store.ts'

export const SPEND_NOTE = "spend not settled — Hermes doesn't report complete costs"

// -------------------------------------------------------------------------------------------------- summaries

const unconfirmedOf = (attempts: AttemptRow[]): number =>
  attempts.filter((a) => ['unknown', 'abandoned'].includes(a.state) && a.evidence === null).length

function needsYouOf(
  sqlite: DatabaseSync,
  o: OrchRow,
  wf: WfRunRow,
  nodes: WfNodeRow[],
  attempts: AttemptRow[],
  journal: ExecutionJournal | undefined,
  facts: Pick<CodingWorkerFacts, 'checkPolicy'> | undefined,
): WorkflowNeedsYou[] {
  const result: WorkflowNeedsYou[] = []
  const stepNode = new Map(wfStepsOf(sqlite, o.id).map((s) => [s.step_id, s.node_id]))
  for (const gate of gatesOf(sqlite, o.id))
    if (gate.status === 'open')
      result.push({
        kind: 'gate',
        gateId: gate.id,
        gateKind: 'assignment',
        nodeId: stepNode.get(gate.step_id) ?? '',
      })
  for (const gate of wfGatesOf(sqlite, o.id))
    if (gate.status === 'open')
      result.push({ kind: 'gate', gateId: gate.id, gateKind: 'node', nodeId: gate.node_id })
  if (o.status === 'paused' && o.pause_reason !== null && o.pause_reason !== 'person') {
    const reason = o.pause_reason as Extract<WorkflowNeedsYou, { kind: 'paused' }>['reason']
    result.push(
      ['budget', 'unknown_spend', 'deadline'].includes(reason)
        ? { kind: 'budget', reason }
        : { kind: 'paused', reason },
    )
  }
  for (const attempt of unknownFenceAttempts(o, attempts))
    result.push({
      kind: 'unknown',
      attemptId: attempt.id,
      nodeId: attempt.step_id ? (stepNode.get(attempt.step_id) ?? null) : null,
    })
  for (const attempt of cancelFenceAttempts(o, attempts))
    result.push({ kind: 'cancel_fence', stepId: attempt.step_id ?? '', attemptId: attempt.id })
  if (!isTerminalStatus(o.status) && isFenced(sqlite))
    result.push({ kind: 'fence', reason: 'global' })
  // 7.7c: a coding step that never started because what it was going to read was withdrawn has its own item (re-run the
  // upstream step, then retry this one) instead of the abandoned-attempt Retry.
  const stepById = new Map(stepsOf(sqlite, o.id).map((step) => [step.id, step]))
  const withdrawn = new Set<string>()
  for (const node of nodes) {
    const step = node.step_id ? stepById.get(node.step_id) : undefined
    const last = step
      ? attempts
          .filter((a) => a.step_id === step.id)
          .reduce<AttemptRow | undefined>((b, a) => (!b || a.n > b.n ? a : b), undefined)
      : undefined
    if (
      node.state === 'unresolved' &&
      step &&
      last !== undefined &&
      last.runtime !== 'hermes' &&
      ((step.status === 'cancelled' && step.disposition === 'inputs_withdrawn') ||
        (step.status === 'blocked' && /^input_withdrawn/.test(step.disposition ?? '')))
    )
      withdrawn.add(node.node_id)
  }
  for (const node of nodes)
    if (withdrawn.has(node.node_id))
      result.push({ kind: 'node_inputs_withdrawn', nodeId: node.node_id })
    else if (node.state === 'unresolved' && node.attempts_used < node.attempts_max)
      result.push({
        kind: 'retry',
        nodeId: node.node_id,
        attemptsLeft: node.attempts_max - node.attempts_used,
      })
  if (!isTerminalStatus(o.status) && o.status !== 'stopping' && o.status !== 'finishing') {
    // 8.6: a coding step held because its agent is below its quota floor (the step stays queued; the node keeps it).
    const holds = holdsOf(sqlite, o.id)
    for (const hold of holds) {
      const step = stepById.get(hold.step_id)
      if (hold.state !== 'held' || !step || !['queued', 'pending_gate'].includes(step.status))
        continue
      result.push({
        kind: 'quota_low',
        nodeId: stepNode.get(step.id) ?? '',
        agentId: hold.agent_id,
        window: hold.window,
        group: hold.group_name,
        leftPercent: hold.left_percent,
        resetsAt: hold.resets_at,
      })
    }
    // 7.7c: coding steps held for the person. Each keeps its node's step and its one suspended attempt.
    const suspended = new Set(
      attempts.filter((a) => a.suspended && a.step_id !== null).map((a) => a.step_id),
    )
    const held = stepsOf(sqlite, o.id).filter(
      (step) => step.status === 'blocked' && suspended.has(step.id),
    )
    // A coding agent whose settings changed (same agent version): "Use the new settings" on the node. A replaced agent
    // (another version) is the remap item below.
    const frozen = new Map(
      (
        sqlite
          .prepare('SELECT agent_id, incarnation FROM orc_agent_map WHERE orchestration_id = ?')
          .all(o.id) as { agent_id: string; incarnation: string }[]
      ).map((row) => [row.agent_id, row.incarnation]),
    )
    for (const step of held) {
      if (step.disposition !== 'agent_changed' && step.disposition !== 'permission_forbidden')
        continue
      const current = lifecycleOf(sqlite, step.agent_id)?.incarnation_id ?? 'untracked'
      if (frozen.get(step.agent_id) !== current) continue
      const stored = readWorkerPolicy(sqlite, o.id, step.agent_id)
      result.push({
        kind: 'coding_agent_changed',
        nodeId: stepNode.get(step.id) ?? '',
        agentId: step.agent_id,
        newPolicyId: stored ? currentPolicyId(facts, step.agent_id, stored.policy) : null,
        reach: stored?.reach ?? null,
      })
    }
    // A coding step whose start was held back 20 times: Try again renews it (until the last renewal is used).
    const renewals = new Map(nodes.map((n) => [n.node_id, n.renewals]))
    for (const step of held) {
      if (step.disposition !== 'held_back') continue
      const nodeId = stepNode.get(step.id) ?? ''
      if ((renewals.get(nodeId) ?? 0) < WORKFLOW_LIMITS.maxRenewalsPerNode)
        result.push({ kind: 'coding_held_back', nodeId })
    }
    if (held.some((step) => step.disposition === 'coding_limit'))
      result.push({
        kind: 'coding_limit',
        used: executedLaunches(sqlite, o.id),
        limit: o.coding_steps,
      })
  }
  for (const attempt of attempts)
    if (attempt.needs_person && attempt.state === 'created' && attempt.step_id)
      result.push({
        kind: 'refusal_limit',
        nodeId: stepNode.get(attempt.step_id) ?? '',
        attemptId: attempt.id,
        refusals: attempt.refused_total,
      })
  if (!isTerminalStatus(o.status) && o.status !== 'stopping' && o.status !== 'finishing') {
    const mapped = sqlite
      .prepare(
        'SELECT agent_id, incarnation FROM orc_agent_map WHERE orchestration_id = ? ORDER BY agent_id',
      )
      .all(o.id) as { agent_id: string; incarnation: string }[]
    for (const row of mapped) {
      const current = lifecycleOf(sqlite, row.agent_id)?.incarnation_id ?? 'untracked'
      if (current === row.incarnation) continue
      const plan =
        current === 'untracked'
          ? { nodeIds: [] as string[], items: [] }
          : remapPlan(sqlite, o, wf, row.agent_id, journal)
      result.push({
        kind: 'remap',
        agentId: row.agent_id,
        frozenIncarnation: row.incarnation,
        currentIncarnation: current,
        nodeIds: plan.nodeIds,
        plan: plan.items.map((item) => ({
          nodeId: item.nodeId,
          retiresAttemptId: item.retiresAttemptId,
          payloadHash: item.payloadHash,
          payload: item.payload,
        })),
      })
    }
  }
  return result
}

/** The id the agent's stored policy has now, when it can be told without asking the CLI again; null otherwise. */
function currentPolicyId(
  facts: Pick<CodingWorkerFacts, 'checkPolicy'> | undefined,
  agentId: string,
  policy: WorkerPolicy,
): string | null {
  try {
    const check = facts?.checkPolicy(agentId, policy)
    return check?.ok ? check.id : null
  } catch {
    return null
  }
}

/** Launches that may have executed (the database's projection of the coding journal; the limit itself is judged on the journal). */
const executedLaunches = (sqlite: DatabaseSync, orchId: string): number =>
  (
    sqlite
      .prepare(
        'SELECT COUNT(*) AS n FROM coding_launches WHERE owner_orchestration = ? AND may_have_executed = 1',
      )
      .get(orchId) as { n: number }
  ).n

/** The run's coding authorisation as it stands now (7.7c §6); undefined for a workflow without coding agents. */
function codingBlockOf(sqlite: DatabaseSync, o: OrchRow): WorkflowCodingBlock | undefined {
  const workers = workerPoliciesOf(sqlite, o.id)
  if (workers.length === 0) return undefined
  return {
    workers: workers.map((stored) => ({
      agentId: stored.agentId,
      runtime: stored.policy.runtime as 'claude-code' | 'codex',
      policyId: stored.policyId,
      reach: stored.reach,
      reachBeyondWorkspace: stored.reachBeyondWorkspace,
    })),
    codingSteps: o.coding_steps,
    used: executedLaunches(sqlite, o.id),
    acceptedUnknownCost: o.accepted_unknown_cost.filter(
      (source): source is 'hermes' | 'claude-code' | 'codex' =>
        source === 'hermes' || source === 'claude-code' || source === 'codex',
    ),
    unknownSpend: o.accepted_unknown_spend ? 'continue' : 'pause',
    quotaFloorPercent: o.quota_floor_percent,
  }
}

export function workflowSummaryOf(
  sqlite: DatabaseSync,
  o: OrchRow,
  journal?: ExecutionJournal,
  facts?: Pick<CodingWorkerFacts, 'checkPolicy'>,
): WorkflowRunSummary {
  const wf = requireWfRun(sqlite, o.id)
  const nodes = nodesOf(sqlite, o.id)
  const attempts = attemptsOf(sqlite, o.id)
  const count = (state: string) => nodes.filter((n) => n.state === state).length
  const unconfirmed = unconfirmedOf(attempts)
  const coding = codingBlockOf(sqlite, o)
  const outcomeNote =
    wf.graph_outcome === 'reached_end'
      ? unconfirmed > 0
        ? `Workflow reached its end — ${unconfirmed} step run${unconfirmed === 1 ? '' : 's'} not confirmed as ended`
        : 'Workflow reached its end'
      : wf.graph_outcome === 'failed'
        ? (wf.graph_reason ?? 'The graph failed').slice(0, 280)
        : wf.graph_outcome === 'stopped'
          ? (o.end_reason ?? 'The run was stopped').slice(0, 280)
          : null
  return {
    id: o.id,
    title: o.title,
    workflowId: wf.workflow_id,
    workflowName: wf.workflow_name,
    version: wf.version,
    status: o.status,
    pauseReason:
      o.status === 'paused' ? (o.pause_reason as WorkflowRunSummary['pauseReason']) : null,
    graphOutcome: wf.graph_outcome,
    outcomeNote,
    gatePolicy: wf.gate_policy,
    roomId: o.room_id,
    briefId: o.brief_id,
    revision: o.revision,
    ownership: ownershipOf(o, attempts),
    nodes: {
      total: nodes.length,
      waiting: count('waiting'),
      ready: count('ready'),
      running: count('running'),
      gateOpen: count('gate_open'),
      succeeded: count('succeeded'),
      failed: count('failed'),
      skipped: count('skipped'),
      unresolved: count('unresolved'),
    },
    needsYou: needsYouOf(sqlite, o, wf, nodes, attempts, journal, facts),
    ...(coding === undefined ? {} : { coding }),
    unconfirmed,
    rerunOf: wf.rerun_of,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    endedAt: o.ended_at,
  }
}
