import type {
  GateDecision,
  WorkflowRemapDecision,
  WorkflowRetryDecision,
  WorkflowTryAgainDecision,
} from '@score/contract'
import { HttpError } from '../../errors.ts'
import { lifecycleOf } from '../agent-lifecycle.ts'
import { journalSoft, touch, type Ctx } from '../orchestration/ctx.ts'
import { stopRun } from '../orchestration/decisions.ts'
import { bumpAdmission, refuseAttempt, setStepStatus, withdrawGates } from '../orchestration/ops.ts'
import type { ExecutionJournal } from '../orchestration/journal.ts'
import {
  addHistory,
  attemptsOf,
  frozenIncarnation,
  isTerminalStatus,
  requireOrch,
  stepsOf,
  type OrchRow,
} from '../orchestration/store.ts'
import { setNode, nodesOf, requireWfRun } from './store.ts'
import { remapPlan } from './views.ts'

// Decisions that only workflows have (contract §15): node gates, Retry, Try again and the workflow form of Remap. All
// are revision-bound: a stale run revision (or node / gate revision) is `409 conflict`.

function expectRevision(o: OrchRow, revision: number): void {
  if (o.revision !== revision)
    throw new HttpError(
      409,
      'conflict',
      'This run changed while you were looking. Reload and try again.',
      {
        currentRevision: o.revision,
      },
    )
}
const mustBeLive = (o: OrchRow): void => {
  if (isTerminalStatus(o.status) || o.status === 'stopping' || o.status === 'finishing')
    throw new HttpError(409, 'not_open', `This run is ${o.status}.`)
}

export function decideNodeGate(ctx: Ctx, orchId: string, gateId: string, body: GateDecision): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const gate = sqlite
    .prepare('SELECT * FROM wf_gates WHERE orchestration_id = ? AND id = ?')
    .get(orchId, gateId) as
    | { node_id: string; status: string; revision: number; payload: string; payload_hash: string }
    | undefined
  if (!gate) throw new HttpError(404, 'not_found', 'Couldn’t find that gate.')
  if (gate.status !== 'open' || gate.revision !== body.expectedRevision)
    throw new HttpError(409, 'conflict', 'This gate was already decided or has changed.', {
      currentRevision: gate.revision,
    })
  const wf = requireWfRun(sqlite, orchId)
  const def = wf.definition.nodes.find((n) => n.id === gate.node_id)
  const node = nodesOf(sqlite, orchId).find((n) => n.node_id === gate.node_id)
  if (!def || def.kind !== 'gate' || !node)
    throw new HttpError(404, 'not_found', 'Couldn’t find that gate.')
  const payload = JSON.parse(gate.payload) as { nodeRevision: number }
  if (node.revision !== payload.nodeRevision)
    throw new HttpError(409, 'conflict', 'The step changed since the gate opened.', {
      currentRevision: node.revision,
    })
  // The evidence the gate displayed must still stand: same revisions, still resolved.
  const byNode = new Map(nodesOf(sqlite, orchId).map((n) => [n.node_id, n]))
  for (const shown of (
    JSON.parse(gate.payload) as { consumed: { nodeId: string; outputRevision: number }[] }
  ).consumed) {
    const producer = byNode.get(shown.nodeId)
    if (
      !producer ||
      !['succeeded', 'failed'].includes(producer.state) ||
      producer.output_revision !== shown.outputRevision
    )
      throw new HttpError(409, 'conflict', `${shown.nodeId} changed since the gate opened.`, {
        currentRevision: gate.revision,
      })
  }
  const approve = body.decision === 'approve'
  sqlite
    .prepare(
      'UPDATE wf_gates SET status = ?, revision = revision + 1, note = ?, decided_at = ? WHERE orchestration_id = ? AND id = ?',
    )
    .run(approve ? 'approved' : 'rejected', body.note ?? null, now, orchId, gateId)
  addHistory(
    sqlite,
    orchId,
    'wf_gate_decided',
    {
      gateId,
      nodeId: gate.node_id,
      state: approve ? 'approved' : 'rejected',
      payloadHash: gate.payload_hash,
    },
    now,
  )
  const edges = wf.definition.edges.filter((e) => e.from === gate.node_id)
  const emit = (chosen: string, kind: 'ok' | 'rejected') => {
    for (const edge of edges)
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO wf_tokens (orchestration_id, edge_id, kind, produced_by, produced_attempt, consumed_by, created_at) VALUES (?, ?, ?, ?, 0, NULL, ?)`,
        )
        .run(orchId, edge.id, edge.port === chosen ? kind : 'skip', gate.node_id, now)
  }
  if (approve) {
    setNode(sqlite, orchId, gate.node_id, { state: 'succeeded', reason: 'approved', ended_at: now })
    emit('ok', 'ok')
  } else if (def.onReject === 'route') {
    // The rejection is a route, not a failure: the gate node itself completed.
    setNode(sqlite, orchId, gate.node_id, { state: 'succeeded', reason: 'rejected', ended_at: now })
    emit('rejected', 'rejected')
  } else {
    setNode(sqlite, orchId, gate.node_id, {
      state: 'cancelled',
      reason: 'rejected: the run stops',
      ended_at: now,
    })
    sqlite
      .prepare(
        "UPDATE wf_runs SET graph_outcome = 'stopped', graph_reason = 'a gate was rejected' WHERE orchestration_id = ?",
      )
      .run(orchId)
    stopRun(ctx, orchId, 'graph', 'stopped: a gate was rejected')
  }
  touch(ctx, orchId)
}

/** Retry: the person's decision for a node whose attempt was administratively abandoned (and has attempts left). */
export function retryNode(
  ctx: Ctx,
  orchId: string,
  nodeId: string,
  body: WorkflowRetryDecision,
): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const node = nodesOf(sqlite, orchId).find((n) => n.node_id === nodeId)
  if (!node) throw new HttpError(404, 'not_found', 'Couldn’t find that step.')
  if (node.revision !== body.expectedNodeRevision)
    throw new HttpError(409, 'conflict', 'The step changed while you were looking.', {
      currentRevision: node.revision,
    })
  if (node.state !== 'unresolved' || node.attempts_used >= node.attempts_max)
    throw new HttpError(
      409,
      'not_retryable',
      'Only an abandoned step that has retries left can be retried.',
    )
  journalSoft(ctx, () =>
    ctx.journal.append({ kind: 'transition', orchestrationId: orchId, what: 'retry', nodeId }),
  )
  setNode(sqlite, orchId, nodeId, {
    state: 'ready',
    step_id: null,
    ended_at: null,
    reason: 'retrying after the step run we stopped waiting for',
  })
  addHistory(sqlite, orchId, 'node_retried', { nodeId, state: 'ready' }, now)
  bumpAdmission(sqlite)
  touch(ctx, orchId)
}

/** Continue a node whose dispatch Hermes refused the lifetime limit of times. */
export function tryAgain(
  ctx: Ctx,
  orchId: string,
  nodeId: string,
  body: WorkflowTryAgainDecision,
): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const node = nodesOf(sqlite, orchId).find((n) => n.node_id === nodeId)
  if (!node) throw new HttpError(404, 'not_found', 'Couldn’t find that step.')
  if (node.revision !== body.expectedNodeRevision)
    throw new HttpError(409, 'conflict', 'The step changed while you were looking.', {
      currentRevision: node.revision,
    })
  const attempt = attemptsOf(sqlite, orchId).find(
    (a) => a.step_id === node.step_id && a.needs_person && a.state === 'created',
  )
  if (!attempt) throw new HttpError(409, 'not_open', 'This step isn’t waiting for you.')
  journalSoft(ctx, () =>
    ctx.journal.append({ kind: 'transition', orchestrationId: orchId, what: 'try_again', nodeId }),
  )
  sqlite
    .prepare(
      'UPDATE orc_attempts SET needs_person = 0, refused_total = 0, refused_streak = 0, next_try_at = NULL, updated_at = ? WHERE id = ?',
    )
    .run(now, attempt.id)
  setNode(sqlite, orchId, nodeId, { reason: 'trying again after your decision' })
  addHistory(sqlite, orchId, 'node_try_again', { nodeId, attemptId: attempt.id }, now)
  bumpAdmission(sqlite)
  touch(ctx, orchId)
}

/**
 * Remap (v8.1 item 1): the workflow form of "use the new <agent>". Provably unsent steps of the agent are retired with
 * disposition `remapped` (their gates withdrawn) and re-created for the new incarnation; possibly-sent work keeps its
 * attempt and obligations, the new mapping applies to later work. The decision names the exact payloads it approves.
 */
export function remapWorkflow(
  ctx: Ctx,
  orchId: string,
  body: WorkflowRemapDecision,
  journal: ExecutionJournal,
): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const frozen = frozenIncarnation(sqlite, orchId, body.agentId)
  if (frozen === undefined)
    throw new HttpError(404, 'not_found', `${body.agentId} is not an agent of this run.`)
  const current = lifecycleOf(sqlite, body.agentId)?.incarnation_id ?? 'untracked'
  if (
    frozen !== body.frozenIncarnation ||
    current !== body.currentIncarnation ||
    current === 'untracked'
  )
    throw new HttpError(409, 'conflict', `${body.agentId} changed again. Look at the run again.`)
  if (frozen === current) throw new HttpError(409, 'conflict', `${body.agentId} was not replaced.`)
  const wf = requireWfRun(sqlite, orchId)
  const plan = remapPlan(sqlite, o, wf, body.agentId, journal)
  const wanted = new Map(body.plan.map((p) => [p.nodeId, p.payloadHash]))
  if (
    plan.items.length !== wanted.size ||
    plan.items.some((item) => wanted.get(item.nodeId) !== item.payloadHash)
  )
    throw new HttpError(
      409,
      'stale_plan',
      'The work this would recreate has changed. Look at the card again.',
      {
        currentRevision: o.revision,
      },
    )
  const nodes = new Map(nodesOf(sqlite, orchId).map((n) => [n.node_id, n]))
  for (const item of plan.items)
    if ((nodes.get(item.nodeId)?.remaps ?? 0) >= 2)
      throw new HttpError(409, 'conflict', `${item.nodeId} was already reassigned twice.`)
  journalSoft(ctx, () =>
    ctx.journal.append({
      kind: 'remap',
      orchestrationId: orchId,
      agentId: body.agentId,
      incarnation: current,
    }),
  )
  sqlite
    .prepare(
      'UPDATE orc_agent_map SET incarnation = ?, updated_at = ? WHERE orchestration_id = ? AND agent_id = ?',
    )
    .run(current, now, orchId, body.agentId)
  const steps = new Map(stepsOf(sqlite, orchId).map((s) => [s.id, s]))
  const attempts = attemptsOf(sqlite, orchId)
  for (const item of plan.items) {
    const node = nodes.get(item.nodeId)!
    const step = node.step_id ? steps.get(node.step_id) : undefined
    if (step && ['pending_gate', 'queued', 'admitted'].includes(step.status)) {
      for (const attempt of attempts.filter((a) => a.step_id === step.id && a.state === 'created'))
        refuseAttempt(sqlite, attempt, 'not dispatched: remapped', now)
      setStepStatus(sqlite, orchId, step.id, 'not_started', 'remapped', now)
      sqlite
        .prepare('UPDATE orc_steps SET retired = 1 WHERE orchestration_id = ? AND id = ?')
        .run(orchId, step.id)
      withdrawGates(sqlite, orchId, now, step.id)
      sqlite
        .prepare(
          "UPDATE orc_gates SET status = 'withdrawn', revision = revision + 1, decided_at = ? WHERE orchestration_id = ? AND step_id = ? AND status = 'approved'",
        )
        .run(now, orchId, step.id)
    }
    setNode(sqlite, orchId, item.nodeId, {
      state: 'ready',
      step_id: null,
      remaps: node.remaps + 1,
      reason: 'remapped to the new agent',
    })
  }
  // The planner's next pass re-creates the work under a new generation (a distinct command identity).
  sqlite
    .prepare(
      'UPDATE wf_runs SET planner_generation = planner_generation + 1 WHERE orchestration_id = ?',
    )
    .run(orchId)
  addHistory(
    sqlite,
    orchId,
    'agent_remapped',
    { agentId: body.agentId, from: frozen, to: current, nodes: plan.nodeIds },
    now,
  )
  bumpAdmission(sqlite)
  touch(ctx, orchId)
}
