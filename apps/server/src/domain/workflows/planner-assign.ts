import type { DatabaseSync } from 'node:sqlite'
import { agentAdmits, lifecycleOf } from '../agent-lifecycle.ts'
import { budgetView, canReserve, unknownCostBlocks } from '../orchestration/budget.ts'
import { readWorkerPolicy } from '../orchestration/coding-policy.ts'
import { addStored, storageRoom, utf8Bytes } from '../orchestration/ops.ts'
import { frozenIncarnation, readOrch, type OrchRow } from '../orchestration/store.ts'
import { renderAgentPayload } from './payload.ts'
import { START, defOf, hashOf, setState, type Pass } from './planner-context.ts'
import { agentAncestors } from './planner-graph.ts'
import { currentStep, lastAttemptOf, onAgentFailure } from './planner-observe.ts'
import { setNode, type WfNodeRow, type WfRunRow } from './store.ts'

type NodeWait = 'budget' | 'unknown_spend' | 'remap' | 'agent_unavailable' | null

/** Conditions that can still change; they never produce a stored refusal. */
export function assignWait(
  sqlite: DatabaseSync,
  o: OrchRow,
  wf: WfRunRow,
  agentId: string,
): NodeWait {
  const frozen = frozenIncarnation(sqlite, o.id, agentId)
  const current = lifecycleOf(sqlite, agentId)?.incarnation_id ?? 'untracked'
  if (frozen !== undefined && frozen !== current) return 'remap'
  if (!agentAdmits(sqlite, agentId)) return 'agent_unavailable'
  const view = budgetView(sqlite, o)
  if (unknownCostBlocks(sqlite, o, view)) return 'unknown_spend'
  return null
}

function pendingKind(
  p: Pass,
  node: WfNodeRow,
): { attempt: number; reason: 'initial' | 'retry' | 'remap' } {
  if (node.attempts_used === 0) return { attempt: 1, reason: 'initial' }
  const last = currentStep(p, node.node_id)
  if (last && (last.status === 'blocked' || last.status === 'not_started')) {
    // A coding step whose inputs were withdrawn gave its try back (`unresolvedWithdrawn`): the next step consumes that
    // slot, once, as a retry. Read as a remap it would keep the count and run the node past `attempts_max` (F1 #3).
    const attempt = lastAttemptOf(p, last.id)
    const refunded =
      /^input_withdrawn/.test(last.disposition ?? '') &&
      attempt !== undefined &&
      attempt.runtime !== 'hermes'
    if (!refunded) return { attempt: node.attempts_used, reason: 'remap' }
  }
  return { attempt: node.attempts_used + 1, reason: 'retry' }
}

function permanentRefusal(
  p: Pass,
  node: WfNodeRow,
  attempt: number,
  code: string,
  message: string,
): void {
  const { sqlite, now } = p.ctx
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO wf_commands (orchestration_id, node_id, attempt, verb, generation, payload_hash, receipt, outcome, created_at)
       VALUES (?, ?, ?, 'assign', ?, ?, ?, 'refused', ?)`,
    )
    .run(
      p.o.id,
      node.node_id,
      attempt,
      p.wf.planner_generation,
      hashOf(`${node.node_id}:${code}`),
      JSON.stringify({ status: 'refused', code, message }),
      now,
    )
  onAgentFailure(p, node, `${code}: ${message}`, false)
}

export function assign(p: Pass, node: WfNodeRow): boolean {
  const { sqlite, now } = p.ctx
  // Several nodes can be assigned in one pass: the step counter is read fresh each time.
  p.o = readOrch(sqlite, p.o.id) ?? p.o
  const def = defOf(p, node.node_id)
  if (def.kind !== 'agent') return false
  const { attempt, reason } = pendingKind(p, node)
  const generation = p.wf.planner_generation
  const stored = sqlite
    .prepare(
      "SELECT outcome FROM wf_commands WHERE orchestration_id = ? AND node_id = ? AND attempt = ? AND verb = 'assign' AND generation = ?",
    )
    .get(p.o.id, node.node_id, attempt, generation) as { outcome: string } | undefined
  if (stored) return false
  // Readiness is revalidated at assignment: a producer whose result was withdrawn after this node became ready
  // (it is unresolved again) no longer supports it. The node waits until that producer is resolved again.
  if (
    agentAncestors(p, node.node_id).some(
      (id) => !['succeeded', 'failed'].includes(p.nodes.get(id)!.state),
    )
  ) {
    if (node.reason !== 'evidence withdrawn')
      setNode(sqlite, p.o.id, node.node_id, { reason: 'evidence withdrawn' })
    return false
  }
  const wait = assignWait(sqlite, p.o, p.wf, def.agentId)
  if (wait) {
    if (node.reason !== wait && wait === 'remap')
      setNode(sqlite, p.o.id, node.node_id, { reason: 'remap' })
    return false
  }
  if (p.o.steps_created >= p.o.max_steps)
    return (
      permanentRefusal(
        p,
        node,
        attempt,
        'step_limit',
        `The run is limited to ${p.o.max_steps} steps`,
      ),
      true
    )
  const rendered = renderAgentPayload({
    runId: p.o.id,
    nodeId: node.node_id,
    def: p.wf.definition,
    inputs: p.wf.inputs,
    nodes: p.nodes,
  })
  if (!rendered.ok)
    return (permanentRefusal(p, node, attempt, rendered.code, rendered.message), true)
  const estimate = def.estimateUsd ?? p.o.step_estimate_usd
  const view = budgetView(sqlite, p.o)
  if (!canReserve(view, estimate)) return false
  // Under every-step a re-created (remapped or retried) step needs its own approval of the new frozen payload.
  const everyStep = p.wf.gate_policy === 'every-step'
  const payloadHash = hashOf(rendered.text)
  const bytes = utf8Bytes(rendered.text) * (everyStep ? 2 : 1) + 512
  if (bytes > storageRoom(p.o))
    return (
      permanentRefusal(p, node, attempt, 'quota', "This run's storage allowance is used up"),
      true
    )

  const seq = p.o.steps_created + 1
  const stepId = `s${seq}`
  const life = lifecycleOf(sqlite, def.agentId)
  const incarnation = life?.incarnation_id ?? 'untracked'
  const previous = currentStep(p, node.node_id)
  sqlite
    .prepare(
      `INSERT INTO orc_steps (orchestration_id, id, seq, agent_id, agent_incarnation, instruction, after_steps, replaces, status, estimate_usd, payload_hash, created_in_attempt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.o.id,
      stepId,
      seq,
      def.agentId,
      incarnation,
      rendered.text,
      previous?.id ?? null,
      everyStep ? 'pending_gate' : 'queued',
      estimate,
      payloadHash,
      START,
      now,
      now,
    )
  sqlite
    .prepare('UPDATE orchestrations SET steps_created = steps_created + 1 WHERE id = ?')
    .run(p.o.id)
  let gateId: string | null = null
  if (everyStep) {
    gateId = `g${(sqlite.prepare('SELECT COUNT(*) AS n FROM orc_gates WHERE orchestration_id = ?').get(p.o.id) as { n: number }).n + 1}`
    // A coding step is approved for the settings it will run under (7.7b §12a): the gate names the policy id, admission and
    // release require it to match, and an approval for an old id never covers a new one (7.7c §4).
    const policyId = readWorkerPolicy(sqlite, p.o.id, def.agentId)?.policyId
    const payload = {
      agentId: def.agentId,
      agentIncarnation: incarnation,
      instruction: rendered.text,
      after: [] as string[],
      replaces: previous?.id ?? null,
      estimateUsd: estimate,
      dependencyRevisions: {} as Record<string, number>,
      ...(policyId === undefined ? {} : { policyId }),
    }
    const text = JSON.stringify(payload)
    sqlite
      .prepare(
        `INSERT INTO orc_gates (orchestration_id, id, step_id, requested_by, payload, payload_hash, status, created_at) VALUES (?, ?, ?, 'policy', ?, ?, 'open', ?)`,
      )
      .run(p.o.id, gateId, stepId, text, hashOf(text), now)
  }
  sqlite
    .prepare(
      'INSERT INTO wf_steps (orchestration_id, step_id, node_id, attempt, reason) VALUES (?, ?, ?, ?, ?)',
    )
    .run(p.o.id, stepId, node.node_id, attempt, reason)
  const insertConsumed = sqlite.prepare(
    `INSERT OR REPLACE INTO wf_consumed (orchestration_id, step_id, consumer, consumer_attempt, producer, producer_attempt, producer_step, output_revision, kind, withdrawn)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
  for (const c of rendered.consumed)
    insertConsumed.run(
      p.o.id,
      stepId,
      node.node_id,
      attempt,
      c.producer,
      c.attempt,
      p.nodes.get(c.producer)?.step_id ?? '',
      c.revision,
      c.kind,
    )
  // Readiness provenance: the results that made this node ready are evidence too, whether or not the text uses them.
  const provenance = sqlite.prepare(
    `INSERT OR IGNORE INTO wf_consumed (orchestration_id, step_id, consumer, consumer_attempt, producer, producer_attempt, producer_step, output_revision, kind, withdrawn)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
  for (const producerId of agentAncestors(p, node.node_id)) {
    const producer = p.nodes.get(producerId)!
    provenance.run(
      p.o.id,
      stepId,
      node.node_id,
      attempt,
      producerId,
      producer.attempts_used,
      producer.step_id ?? '',
      producer.output_revision,
      producer.state === 'failed' ? 'failure' : 'output',
    )
  }
  sqlite
    .prepare(
      `INSERT INTO wf_commands (orchestration_id, node_id, attempt, verb, generation, payload_hash, receipt, outcome, created_at)
       VALUES (?, ?, ?, 'assign', ?, ?, ?, 'ok', ?)`,
    )
    .run(
      p.o.id,
      node.node_id,
      attempt,
      generation,
      payloadHash,
      JSON.stringify({ status: 'ok', stepId }),
      now,
    )
  addStored(sqlite, p.o.id, bytes)
  setState(p, node.node_id, everyStep ? 'gate_open' : 'running', {
    step_id: stepId,
    attempts_used: reason === 'remap' ? node.attempts_used : attempt,
    gate_id: gateId,
    reason: everyStep ? 'waiting for your approval' : null,
    started_at: node.started_at ?? now,
  })
  return true
}
