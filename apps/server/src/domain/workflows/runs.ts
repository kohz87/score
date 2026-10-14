import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ORCH_LIMITS,
  WORKFLOW_LIMITS,
  type WorkflowRunCreate,
  type WorkflowVersion,
} from '@score/contract'
import type { WorkerReport } from '../orchestration/supported-agents.ts'
import { HttpError } from '../../errors.ts'
import { briefTitle, createBrief, emitBriefChange } from '../briefs.ts'
import { lifecycleOf } from '../agent-lifecycle.ts'
import { storeMessage, insertRoom } from '../rooms.ts'
import { journalSoft, touch, type Ctx } from '../orchestration/ctx.ts'
import { addHistory } from '../orchestration/store.ts'
import { codingItemsFor, WORKFLOW_CODING_ITEM_BYTES } from '../orchestration/ops.ts'
import { storeWorkerPolicy } from '../orchestration/coding-policy.ts'
import { startEdge } from './planner.ts'
import { graphOf, bytesOf, definitionHash } from './definition.ts'

// Creating a workflow run (contract §15 "Runs"): the same rows as an orchestration, planner 'workflow', plus the frozen
// definition, inputs, mapping and the graph projection.

/** Per-run storage reserve: every step can keep its input three times (attempt, reply row, intent) and its output. */
export const WORKFLOW_STEP_BYTES = 256 * 1024
export const workflowReserve = (steps: number, codingItems = 0): number =>
  steps * (WORKFLOW_STEP_BYTES + ORCH_LIMITS.recordsPerItemBytes) +
  ORCH_LIMITS.controlReserveBytes +
  codingItems * WORKFLOW_CODING_ITEM_BYTES

/**
 * The default coding step limit (7.7c §2): each coding step node can take one launch per try, so the nodes × (1 + their
 * retries), at most the 7.7b maximum and at least one.
 */
export const defaultCodingSteps = (
  version: WorkflowVersion,
  codingNodeIds: ReadonlySet<string>,
): number =>
  Math.max(
    1,
    Math.min(
      ORCH_LIMITS.maxCodingSteps,
      version.definition.nodes.reduce(
        (sum, n) => sum + (n.kind === 'agent' && codingNodeIds.has(n.id) ? n.retries + 1 : 0),
        0,
      ),
    ),
  )

export const agentIdsOf = (version: WorkflowVersion): string[] => [
  ...new Set(version.definition.nodes.flatMap((n) => (n.kind === 'agent' ? [n.agentId] : []))),
]

/** Steps the run may create: every logical attempt, plus up to two remap re-creations per agent node. */
export const stepBudgetOf = (version: WorkflowVersion): number => {
  const agents = version.definition.nodes.filter((n) => n.kind === 'agent')
  // At least one: a graph of gates alone creates no steps, but the run row's limit is a positive number.
  return Math.max(
    1,
    Math.min(
      100,
      agents.reduce((sum, n) => sum + (n.kind === 'agent' ? n.retries + 1 : 0), 0) +
        agents.length * WORKFLOW_LIMITS.maxRemapsPerNode,
    ),
  )
}

export function validateInputs(version: WorkflowVersion, inputs: Record<string, string>): void {
  const declared = new Map(version.definition.inputs.map((i) => [i.name, i]))
  const problems: string[] = []
  for (const name of Object.keys(inputs))
    if (!declared.has(name)) problems.push(`${name} is not an input of this workflow`)
  for (const input of declared.values()) {
    const value = Object.hasOwn(inputs, input.name) ? inputs[input.name] : undefined
    if (input.required && (value === undefined || value.trim() === ''))
      problems.push(`${input.label} is required`)
    if (value !== undefined && [...value].length > input.maxChars)
      problems.push(`${input.label} is longer than ${input.maxChars} characters`)
  }
  if (problems.length > 0)
    throw new HttpError(422, 'invalid_inputs', problems.join('; '), { problems })
}

/** What a workflow with coding step nodes starts with (7.7c §2); absent for a workflow without any. */
export interface WorkflowCodingStart {
  /** The report each coding agent's policy came from (preflight, asked before the transaction). */
  reports: Map<string, WorkerReport>
  codingSteps: number
}

export function insertWorkflowRun(
  ctx: Ctx,
  id: string,
  body: WorkflowRunCreate,
  version: WorkflowVersion,
  preflight: unknown,
  coding?: WorkflowCodingStart,
): void {
  const { sqlite, now } = ctx
  const def = version.definition
  const agents = agentIdsOf(version)
  const steps = stepBudgetOf(version)
  const codingItems = coding ? codingItemsFor(steps, coding.codingSteps) : 0
  const title = briefTitle(`${def.name}`)
  const roomId = `room-${id}`
  const messageId = `orc-goal:${id}`
  const goal = `Run workflow "${def.name}" (version ${version.version})`
  insertRoom(
    sqlite,
    {
      id: roomId,
      name: `Workflow: ${title.slice(0, 80)} (${id.slice(4)})`,
      kind: 'room',
      leadAgentId: null,
      members: agents,
    },
    now,
  )
  ctx.events.push(
    ...storeMessage(
      sqlite,
      {
        id: messageId,
        roomId,
        author: { kind: 'you' },
        to: [],
        parts: [{ kind: 'text', text: goal }],
        createdAt: now,
        streaming: false,
        refs: [],
      },
      now,
    ),
  )
  createBrief(sqlite, { id: messageId, roomId, text: goal }, now)
  const reserve = workflowReserve(steps, codingItems)
  sqlite
    .prepare(
      `INSERT INTO orchestrations (id, title, goal, planner, lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id, gate_policy,
         budget_usd, deadline_at, max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd,
         status, acknowledgement, preflight, reserve_bytes, stored_bytes, created_at, updated_at, accepted_unknown_spend)
       VALUES (?, ?, ?, 'workflow', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0.25, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      title,
      goal,
      JSON.stringify(agents),
      roomId,
      messageId,
      body.gatePolicy === 'every-step' ? 'every-step' : 'none',
      body.budgetUsd ?? null,
      body.deadlineAt ?? null,
      steps,
      body.maxConcurrentSteps,
      body.stepEstimateUsd,
      JSON.stringify({ text: ORCH_ACKNOWLEDGEMENT_TEXT, at: now }),
      JSON.stringify(preflight),
      reserve,
      bytesOf(JSON.stringify(body.inputs)) + 2048,
      now,
      now,
      // 'continue' chosen at start is the person's acceptance of unknown spend; one rule then governs planning, claim
      // and send (and a later limits decision can revoke it).
      body.unknownSpend === 'continue' ? 1 : 0,
    )
  if (coding) {
    // The partition is set here, once, from the planner's own item constant (7.7c §5); `setLimits` grows it the same way.
    sqlite
      .prepare(
        'UPDATE orchestrations SET coding_steps = ?, accepted_unknown_cost = ?, coding_reserve_bytes = ? WHERE id = ?',
      )
      .run(
        coding.codingSteps,
        JSON.stringify([...new Set(body.acceptUnknownCost ?? [])].sort()),
        codingItems * WORKFLOW_CODING_ITEM_BYTES,
        id,
      )
    // The policy each coding agent is approved with, and the acknowledgement that covered it.
    for (const [agentId, report] of coding.reports)
      storeWorkerPolicy(
        sqlite,
        id,
        agentId,
        {
          policyId: report.policyId!,
          policy: report.policy!,
          reach: report.reach!,
          reachBeyondWorkspace: report.reachBeyondWorkspace,
          acknowledged: body.acknowledgeCodingReach?.policyIds.includes(report.policyId!) ?? false,
        },
        now,
      )
    addHistory(
      sqlite,
      id,
      'coding_reach_acknowledged',
      {
        policyIds: [...coding.reports.values()]
          .filter((report) => body.acknowledgeCodingReach?.policyIds.includes(report.policyId!))
          .map((report) => report.policyId),
      },
      now,
    )
    // The limits the person started with are journaled like any later change (verified after a restore).
    journalSoft(ctx, () =>
      ctx.journal.append({
        kind: 'authorization',
        orchestrationId: id,
        budgetUsd: body.budgetUsd ?? null,
        deadlineAt: body.deadlineAt ?? null,
        acceptUnknownSpend: body.unknownSpend === 'continue',
        codingSteps: coding.codingSteps,
        acceptUnknownCost: [...new Set(body.acceptUnknownCost ?? [])].sort(),
      }),
    )
  }
  const freeze = sqlite.prepare(
    "INSERT INTO orc_agent_map (orchestration_id, agent_id, role, incarnation, updated_at) VALUES (?, ?, 'agent', ?, ?)",
  )
  for (const agentId of agents)
    freeze.run(id, agentId, lifecycleOf(sqlite, agentId)?.incarnation_id ?? 'untracked', now)
  sqlite
    .prepare(
      `INSERT INTO wf_runs (orchestration_id, workflow_id, version, workflow_name, definition, definition_hash, inputs, gate_policy, unknown_spend, rerun_of, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      version.workflowId,
      version.version,
      def.name,
      JSON.stringify(def),
      definitionHash(def),
      JSON.stringify(body.inputs),
      body.gatePolicy,
      body.unknownSpend,
      body.rerunOf ?? null,
      now,
    )
  sqlite
    .prepare('UPDATE workflow_versions SET used = 1 WHERE workflow_id = ? AND version = ?')
    .run(version.workflowId, version.version)
  const g = graphOf(def)
  const insertNode = sqlite.prepare(
    "INSERT INTO wf_nodes (orchestration_id, node_id, kind, state, attempts_max) VALUES (?, ?, ?, 'waiting', ?)",
  )
  const insertToken = sqlite.prepare(
    "INSERT INTO wf_tokens (orchestration_id, edge_id, kind, produced_by, produced_attempt, consumed_by, created_at) VALUES (?, ?, 'ok', '__start', 0, NULL, ?)",
  )
  for (const node of def.nodes) {
    insertNode.run(id, node.id, node.kind, node.kind === 'agent' ? node.retries + 1 : 0)
    // Every node without an incoming edge gets one token at start.
    if ((g.inn.get(node.id) ?? []).length === 0) insertToken.run(id, startEdge(node.id), now)
  }
  addHistory(
    sqlite,
    id,
    'created',
    { workflowId: version.workflowId, version: version.version, gatePolicy: body.gatePolicy },
    now,
  )
  touch(ctx, id)
  ctx.events.push(...emitBriefChange(sqlite, messageId, true))
}
