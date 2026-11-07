import {
  type AssignmentGateView,
  type ConsumedView,
  type NodeGateView,
  type NodeView,
  type SpendEvidence,
  type TokenView,
  type WorkflowRunDetail,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { lifecycleOf } from '../agent-lifecycle.ts'
import { budgetView, spendEvidence } from '../orchestration/budget.ts'
import type { CodingWorkerFacts } from '../orchestration/supported-agents.ts'
import { activeStepCounts } from '../orchestration/ops.ts'
import {
  attemptsOf,
  gatesOf,
  stepsOf,
  type AttemptRow,
  type OrchRow,
} from '../orchestration/store.ts'
import { redact } from '../../redact.ts'
import { attemptViewOf, cancelFenceAttempts, gateView, stepViewOf } from '../orchestration/views.ts'
import { holdsOf } from '../orchestration/quota-guard.ts'
import type { ExecutionJournal } from '../orchestration/journal.ts'
import { SPEND_NOTE, workflowSummaryOf } from './views-summary.ts'
import { storageInventory } from './views-storage.ts'
import { waitingFor } from './views-waiting.ts'
import { consumedOf, nodesOf, requireWfRun, tokensOf, wfGatesOf, wfStepsOf } from './store.ts'

// ------------------------------------------------------------------------------------------------------- detail

export function workflowDetailOf(
  sqlite: DatabaseSync,
  o: OrchRow,
  now: string,
  options: {
    lineageProvable: boolean
    journal?: ExecutionJournal
    skipStorage?: boolean
    facts?: Pick<CodingWorkerFacts, 'checkPolicy'>
  },
): WorkflowRunDetail {
  const wf = requireWfRun(sqlite, o.id)
  const summary = workflowSummaryOf(sqlite, o, options.journal, options.facts)
  const nodes = nodesOf(sqlite, o.id)
  const steps = stepsOf(sqlite, o.id)
  const stepById = new Map(steps.map((s) => [s.id, s]))
  const attempts = attemptsOf(sqlite, o.id)
  const lineage = wfStepsOf(sqlite, o.id)
  const gates = gatesOf(sqlite, o.id)
  const counts = activeStepCounts(sqlite)
  const unsentCoding = attempts.filter(
    (a) =>
      a.kind === 'step' &&
      a.runtime !== 'hermes' &&
      ['created', 'send_started', 'running', 'unknown'].includes(a.state),
  ).length
  const stepNode = new Map(lineage.map((l) => [l.step_id, l.node_id]))
  const nodeViews: NodeView[] = nodes.map((n) => {
    const step = n.step_id ? stepById.get(n.step_id) : undefined
    const attempt = step
      ? attempts
          .filter((a) => a.step_id === step.id)
          .reduce<AttemptRow | undefined>((b, a) => (!b || a.n > b.n ? a : b), undefined)
      : undefined
    const open = wfGatesOf(sqlite, o.id).find((g) => g.node_id === n.node_id && g.status === 'open')
    const assignmentGate = step
      ? gates.find((g) => g.step_id === step.id && g.status === 'open')
      : undefined
    return {
      nodeId: n.node_id,
      kind: n.kind as NodeView['kind'],
      state: n.state,
      revision: n.revision,
      waitingFor: waitingFor(sqlite, o, wf, n, step, attempt, now, counts, unsentCoding),
      attemptsUsed: n.attempts_used,
      attemptsMax: n.attempts_max,
      stepId: n.step_id,
      lineage: lineage.filter((l) => l.node_id === n.node_id).map((l) => l.step_id),
      reason: n.reason === null ? null : redact(n.reason).slice(0, 500),
      output: n.output,
      outputTruncated: n.output_truncated,
      outputRevision: n.output_revision,
      verdict: n.verdict,
      gateId: open?.id ?? assignmentGate?.id ?? null,
      refusals:
        attempt && (attempt.refused_total > 0 || attempt.dispatch_generation > 0)
          ? {
              consecutive: attempt.refused_streak,
              lifetime: attempt.refused_total,
              lastGeneration: attempt.dispatch_generation,
              lastState:
                attempt.refused_total > 0 && attempt.state === 'created' ? 'refused' : 'sent',
              nextTryAt: attempt.next_try_at,
            }
          : null,
      remaps: n.remaps,
      renewals: n.renewals,
      canRetry: n.state === 'unresolved' && n.attempts_used < n.attempts_max,
      startedAt: n.started_at,
      endedAt: n.ended_at,
    }
  })
  const tokens: TokenView[] = tokensOf(sqlite, o.id).map((t) => ({
    id: String(t.id),
    edgeId: t.edge_id,
    kind: t.kind,
    producedBy: t.produced_by,
    producedAttempt: t.produced_attempt,
    consumedBy: t.consumed_by,
    createdAt: t.created_at,
  }))
  const nodeById = new Map(nodes.map((n) => [n.node_id, n]))
  const consumed: ConsumedView[] = consumedOf(sqlite, o.id).map((c) => {
    const producer = nodeById.get(c.producer)
    return {
      consumer: c.consumer,
      consumerAttempt: c.consumer_attempt,
      producer: c.producer,
      producerAttempt: c.producer_attempt,
      outputRevision: c.output_revision,
      kind: c.kind,
      eligible:
        !c.withdrawn &&
        (c.kind === 'default' ||
          (producer !== undefined &&
            producer.output_revision === c.output_revision &&
            ['succeeded', 'failed'].includes(producer.state))),
    }
  })
  const nodeGates: NodeGateView[] = wfGatesOf(sqlite, o.id).map((g) => ({
    id: g.id,
    kind: 'node',
    nodeId: g.node_id,
    status: g.status,
    payload: JSON.parse(g.payload) as NodeGateView['payload'],
    payloadHash: g.payload_hash,
    revision: g.revision,
    note: g.note,
    createdAt: g.created_at,
    decidedAt: g.decided_at,
  }))
  const assignmentGates: AssignmentGateView[] = gates.map((g) => ({
    ...gateView(g),
    nodeId: stepNode.get(g.step_id) ?? '',
  }))
  const budget = budgetView(sqlite, o)
  const evidence: SpendEvidence[] = attempts
    .filter((a) => a.run_id !== null)
    .map((a) => ({ attemptId: a.id, ...spendEvidence(sqlite, a, options.lineageProvable) }))
  const settled =
    evidence.length > 0 &&
    evidence.every((e) => e.attributed && e.lineageComplete && e.fresh && e.costScope === 'dollars')
  return {
    ...summary,
    definition: wf.definition,
    inputs: wf.inputs,
    agentMap: (
      sqlite
        .prepare(
          'SELECT agent_id, incarnation FROM orc_agent_map WHERE orchestration_id = ? ORDER BY agent_id',
        )
        .all(o.id) as { agent_id: string; incarnation: string }[]
    ).map((row) => {
      const current = lifecycleOf(sqlite, row.agent_id)?.incarnation_id ?? 'untracked'
      return {
        agentId: row.agent_id,
        incarnation: row.incarnation,
        status:
          current === row.incarnation ? 'current' : current === 'untracked' ? 'removed' : 'changed',
      }
    }),
    plannerGeneration: wf.planner_generation,
    nodeStates: nodeViews,
    tokens,
    consumed,
    nodeGates,
    assignmentGates,
    steps: steps.map((s) => stepViewOf(s, gates, attempts, holdsOf(sqlite, o.id))),
    attempts: attempts.map(attemptViewOf),
    deadlineAt: o.deadline_at,
    maxSteps: o.max_steps,
    maxConcurrentSteps: o.max_concurrent_steps,
    stepEstimateUsd: o.step_estimate_usd,
    budget,
    unknownSpend: o.accepted_unknown_spend ? 'continue' : 'pause',
    spend: { settled, note: settled ? 'spend settled' : SPEND_NOTE, evidence },
    cancelFence: cancelFenceAttempts(o, attempts).map((a) => ({
      stepId: a.step_id ?? '',
      attemptId: a.id,
    })),
    waiverAt: o.waiver_at,
    acknowledgedAt: (JSON.parse(o.acknowledgement) as { at: string }).at,
    endReason: o.end_reason,
    storage: options.skipStorage
      ? {
          reserveBytes: o.reserve_bytes,
          storedBytes: o.stored_bytes,
          protectedBytes: 0,
          items: [],
          compactedControlRecords: 0,
        }
      : storageInventory(sqlite, o),
  }
}
