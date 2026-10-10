import {
  ORCH_CAPACITY,
  WORKFLOW_LIMITS,
  type AssignmentGateView,
  type ConsumedView,
  type NodeGateView,
  type NodeView,
  type RemapPlanItem,
  type SpendEvidence,
  type StorageInventory,
  type TokenView,
  type WaitingFor,
  type WorkflowEvent,
  type WorkflowNeedsYou,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
} from '@score/contract'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { agentAdmits, agentPausedAt, lifecycleOf } from '../agent-lifecycle.ts'
import { budgetView, canReserve, spendEvidence } from '../orchestration/budget.ts'
import { isFenced } from '../orchestration/fence.ts'
import { activeStepCounts } from '../orchestration/ops.ts'
import {
  attemptsOf,
  gatesOf,
  isTerminalStatus,
  stepsOf,
  type AttemptRow,
  type OrchRow,
  type StepRow,
} from '../orchestration/store.ts'
import { redact } from '../../redact.ts'
import { teamPausedAt } from '../team-pause.ts'
import {
  attemptViewOf,
  cancelFenceAttempts,
  gateView,
  ownershipOf,
  stepViewOf,
  unknownFenceAttempts,
} from '../orchestration/views.ts'
import { journalDispatches, type ExecutionJournal } from '../orchestration/journal.ts'
import { renderAgentPayload } from './payload.ts'
import { assignWait } from './planner.ts'
import {
  consumedOf,
  nodesOf,
  requireWfRun,
  tokensOf,
  wfGatesOf,
  wfStepsOf,
  type WfNodeRow,
  type WfRunRow,
} from './store.ts'
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

export const SPEND_NOTE = "spend not settled — Hermes doesn't report complete costs"

// ------------------------------------------------------------------------------------------------ remap plan

/**
 * What a remap of `agentId` would do to work that was never sent (v8.1 item 1): the exact payloads that will be
 * dispatched, so the decision can approve them. Possibly-sent work is not listed; it keeps its attempt.
 */
export function remapPlan(
  sqlite: DatabaseSync,
  o: OrchRow,
  wf: WfRunRow,
  agentId: string,
  journal: ExecutionJournal | undefined,
): { nodeIds: string[]; items: (RemapPlanItem & { stepId: string | null })[] } {
  const nodes = nodesOf(sqlite, o.id)
  const byId = new Map(nodes.map((n) => [n.node_id, n]))
  const steps = new Map(stepsOf(sqlite, o.id).map((s) => [s.id, s]))
  const attempts = attemptsOf(sqlite, o.id)
  const sent = journal?.readOwn()
  const dispatches = sent?.ok ? journalDispatches(sent.entries) : undefined
  const items: (RemapPlanItem & { stepId: string | null })[] = []
  const nodeIds: string[] = []
  for (const def of wf.definition.nodes) {
    if (def.kind !== 'agent' || def.agentId !== agentId) continue
    const node = byId.get(def.id)
    if (!node || !['ready', 'gate_open', 'running'].includes(node.state)) continue
    const step = node.step_id ? steps.get(node.step_id) : undefined
    if (step && !['pending_gate', 'queued', 'admitted', 'blocked'].includes(step.status)) continue
    const attempt = step
      ? attempts
          .filter((a) => a.step_id === step.id)
          .reduce<AttemptRow | undefined>((b, a) => (!b || a.n > b.n ? a : b), undefined)
      : undefined
    // Provably unsent: no attempt, or a `created` one the journal never recorded as sent.
    if (
      attempt &&
      (attempt.state !== 'created' || !dispatches || dispatches.get(attempt.id)?.state === 'sent')
    )
      if (!(
        step?.status === 'blocked' &&
        (attempt.state === 'refused' || attempt.state === 'created')
      ))
        continue
    const rendered = renderAgentPayload({
      runId: o.id,
      nodeId: def.id,
      def: wf.definition,
      inputs: wf.inputs,
      nodes: byId,
    })
    if (!rendered.ok) continue
    nodeIds.push(def.id)
    items.push({
      nodeId: def.id,
      stepId: step?.status === 'blocked' ? null : (step?.id ?? null),
      retiresAttemptId: attempt?.id ?? null,
      payloadHash: hash(rendered.text),
      payload: rendered.text,
    })
  }
  return { nodeIds, items }
}

// ---------------------------------------------------------------------------------------------------- waiting

function waitingFor(
  sqlite: DatabaseSync,
  o: OrchRow,
  wf: WfRunRow,
  node: WfNodeRow,
  step: StepRow | undefined,
  attempt: AttemptRow | undefined,
  now: string,
  counts: ReturnType<typeof activeStepCounts>,
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
  if (attempt?.needs_person) return 'refusal_limit'
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
  if (
    view.limitUsd !== null &&
    view.unknownSpend &&
    !o.accepted_unknown_spend &&
    wf.unknown_spend === 'pause'
  )
    return 'unknown_spend'
  if (!attempt) {
    if (
      (counts.perRun.get(o.id) ?? 0) >= o.max_concurrent_steps ||
      counts.total >= ORCH_CAPACITY.concurrentSteps
    )
      return 'capacity'
    if ((counts.perAgent.get(step.agent_id) ?? 0) >= ORCH_CAPACITY.stepsPerAgent)
      return 'agent_capacity'
  }
  return null
}

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
  for (const node of nodes)
    if (node.state === 'unresolved' && node.attempts_used < node.attempts_max)
      result.push({
        kind: 'retry',
        nodeId: node.node_id,
        attemptsLeft: node.attempts_max - node.attempts_used,
      })
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

export function workflowSummaryOf(
  sqlite: DatabaseSync,
  o: OrchRow,
  journal?: ExecutionJournal,
): WorkflowRunSummary {
  const wf = requireWfRun(sqlite, o.id)
  const nodes = nodesOf(sqlite, o.id)
  const attempts = attemptsOf(sqlite, o.id)
  const count = (state: string) => nodes.filter((n) => n.state === state).length
  const unconfirmed = unconfirmedOf(attempts)
  const outcomeNote =
    wf.graph_outcome === 'reached_end'
      ? unconfirmed > 0
        ? `Graph reached the end — ${unconfirmed} abandoned attempt${unconfirmed === 1 ? '' : 's'} not confirmed ended`
        : 'Graph reached the end'
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
    needsYou: needsYouOf(sqlite, o, wf, nodes, attempts, journal),
    unconfirmed,
    rerunOf: wf.rerun_of,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    endedAt: o.ended_at,
  }
}

// ----------------------------------------------------------------------------------------------------- inventory

const one = <T>(sqlite: DatabaseSync, sql: string, ...args: (string | number)[]): T =>
  sqlite.prepare(sql).get(...args) as T

export function storageInventory(sqlite: DatabaseSync, o: OrchRow): StorageInventory {
  const id = o.id
  const turnIds = (
    sqlite.prepare('SELECT turn_id FROM orc_attempts WHERE orchestration_id = ?').all(id) as {
      turn_id: string
    }[]
  ).map((r) => r.turn_id)
  const marks = turnIds.map(() => '?').join(',') || "''"
  const sum = (sql: string, ...args: (string | number)[]) =>
    one<{ n: number; b: number }>(sqlite, sql, ...args)
  const orc = {
    steps: sum(
      "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(instruction) + LENGTH(COALESCE(result, ''))), 0) AS b FROM orc_steps WHERE orchestration_id = ?",
      id,
    ),
    attempts: sum(
      'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(input)), 0) AS b FROM orc_attempts WHERE orchestration_id = ?',
      id,
    ),
    gates: sum(
      'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS b FROM orc_gates WHERE orchestration_id = ?',
      id,
    ),
  }
  const wfRows = {
    nodes: sum(
      "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(COALESCE(output, '')) + LENGTH(COALESCE(reason, ''))), 0) AS b FROM wf_nodes WHERE orchestration_id = ?",
      id,
    ),
    gates: sum(
      'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS b FROM wf_gates WHERE orchestration_id = ?',
      id,
    ),
    other: sum(
      'SELECT (SELECT COUNT(*) FROM wf_tokens WHERE orchestration_id = ?1) + (SELECT COUNT(*) FROM wf_consumed WHERE orchestration_id = ?1) + (SELECT COUNT(*) FROM wf_steps WHERE orchestration_id = ?1) AS n, 0 AS b',
      id,
    ),
    results: sum(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(output)), 0) AS b FROM wf_results WHERE attempt_id IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?)`,
      id,
    ),
  }
  const receipts = sum(
    'SELECT (SELECT COUNT(*) FROM wf_commands WHERE orchestration_id = ?1) + (SELECT COUNT(*) FROM orc_commands WHERE orchestration_id = ?1) AS n, COALESCE((SELECT SUM(LENGTH(receipt)) FROM wf_commands WHERE orchestration_id = ?1), 0) + COALESCE((SELECT SUM(LENGTH(receipt)) FROM orc_commands WHERE orchestration_id = ?1), 0) AS b',
    id,
  )
  const intents = sum(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS b FROM command_intents WHERE idempotency_key IN (${marks})`,
    ...turnIds,
  )
  const messages = sum(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(parts)), 0) AS b FROM messages WHERE room_id = ?',
    o.room_id,
  )
  const messageRuns = sum(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(input)), 0) AS b FROM message_runs WHERE orchestration_attempt_id IN (SELECT id FROM orc_attempts WHERE orchestration_id = ?)',
    id,
  )
  const runs = sum(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(COALESCE(output, ''))), 0) AS b FROM runs WHERE score_turn_id IN (${marks})`,
    ...turnIds,
  )
  const tools = sum(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(COALESCE(preview, '')) + LENGTH(COALESCE(result_preview, ''))), 0) AS b FROM tool_calls WHERE run_id IN (SELECT id FROM runs WHERE score_turn_id IN (${marks}))`,
    ...turnIds,
  )
  const history = sum(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(detail)), 0) AS b FROM orc_history WHERE orchestration_id = ?',
    id,
  )
  const compacted = one<{ detail: string } | undefined>(
    sqlite,
    "SELECT detail FROM orc_history WHERE orchestration_id = ? AND kind = 'compacted_control' LIMIT 1",
    id,
  )
  return {
    reserveBytes: o.reserve_bytes,
    storedBytes: o.stored_bytes,
    protectedBytes: WORKFLOW_LIMITS.protectedBytes,
    items: [
      {
        kind: 'orchestration_rows',
        rows: 1 + orc.steps.n + orc.attempts.n + orc.gates.n,
        bytes: orc.steps.b + orc.attempts.b + orc.gates.b,
      },
      {
        kind: 'workflow_rows',
        rows: wfRows.nodes.n + wfRows.gates.n + wfRows.other.n + wfRows.results.n,
        bytes: wfRows.nodes.b + wfRows.gates.b + wfRows.results.b,
      },
      { kind: 'receipts', rows: receipts.n, bytes: receipts.b },
      { kind: 'intents', rows: intents.n, bytes: intents.b },
      { kind: 'room_messages', rows: messages.n, bytes: messages.b },
      { kind: 'message_runs', rows: messageRuns.n, bytes: messageRuns.b },
      { kind: 'attempt_runs', rows: runs.n, bytes: runs.b },
      { kind: 'tool_rows', rows: tools.n, bytes: tools.b },
      { kind: 'control_history', rows: history.n, bytes: history.b },
    ],
    compactedControlRecords: compacted
      ? ((JSON.parse(compacted.detail) as { count?: number }).count ?? 0)
      : 0,
  }
}

// ------------------------------------------------------------------------------------------------------- detail

export function workflowDetailOf(
  sqlite: DatabaseSync,
  o: OrchRow,
  now: string,
  options: { lineageProvable: boolean; journal?: ExecutionJournal; skipStorage?: boolean },
): WorkflowRunDetail {
  const wf = requireWfRun(sqlite, o.id)
  const summary = workflowSummaryOf(sqlite, o, options.journal)
  const nodes = nodesOf(sqlite, o.id)
  const steps = stepsOf(sqlite, o.id)
  const stepById = new Map(steps.map((s) => [s.id, s]))
  const attempts = attemptsOf(sqlite, o.id)
  const lineage = wfStepsOf(sqlite, o.id)
  const gates = gatesOf(sqlite, o.id)
  const counts = activeStepCounts(sqlite)
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
      waitingFor: waitingFor(sqlite, o, wf, n, step, attempt, now, counts),
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
    steps: steps.map((s) => stepViewOf(s, gates, attempts)),
    attempts: attempts.map(attemptViewOf),
    deadlineAt: o.deadline_at,
    maxSteps: o.max_steps,
    maxConcurrentSteps: o.max_concurrent_steps,
    stepEstimateUsd: o.step_estimate_usd,
    budget,
    unknownSpend: wf.unknown_spend,
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

// ------------------------------------------------------------------------------------------------------- events

/** Derived on read from the persisted rows: nothing is invented client-side. */
export function workflowEventsOf(sqlite: DatabaseSync, o: OrchRow): WorkflowEvent[] {
  const events: WorkflowEvent[] = []
  const rows = sqlite
    .prepare('SELECT id, kind, detail, at FROM orc_history WHERE orchestration_id = ? ORDER BY id')
    .all(o.id) as { id: number; kind: string; detail: string; at: string }[]
  const kindOf: Record<string, WorkflowEvent['kind']> = {
    wf_node: 'node_state',
    wf_token: 'token',
    wf_failed: 'planner',
    created: 'run_started',
    ended: 'control',
    paused: 'control',
    resumed: 'control',
    stop_requested: 'control',
    finish_requested: 'graph_end',
    limits_changed: 'control',
    abandoned: 'control',
    waiver: 'control',
    agent_remapped: 'control',
    node_retried: 'planner',
    node_try_again: 'planner',
    gate_approved: 'gate_decided',
    gate_rejected: 'gate_decided',
    wf_gate_decided: 'gate_decided',
  }
  for (const row of rows) {
    const kind = kindOf[row.kind]
    if (!kind) continue
    const detail = JSON.parse(row.detail) as Record<string, unknown>
    const nodeId = typeof detail.nodeId === 'string' ? detail.nodeId : null
    events.push({
      id: `h${row.id}`,
      at: row.at,
      kind,
      stepId: typeof detail.stepId === 'string' ? detail.stepId : null,
      attemptId: typeof detail.attemptId === 'string' ? detail.attemptId : null,
      tool: null,
      verdict: typeof detail.state === 'string' ? detail.state : null,
      code: null,
      summary: redact(
        row.kind === 'wf_node'
          ? `${nodeId}: ${String(detail.state)}${detail.reason ? ` (${String(detail.reason)})` : ''}`
          : row.kind === 'wf_token'
            ? `token ${String(detail.kind)} on ${String(detail.edgeId)}`
            : row.kind.replaceAll('_', ' '),
      ).slice(0, 300),
      nodeId,
    })
  }
  return events
}
