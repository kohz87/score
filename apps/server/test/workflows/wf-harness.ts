import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowRunCreate,
  type WorkflowRunDetail,
} from '@score/contract'
import { createWorkflow } from '../../src/domain/workflows/definitions.ts'
import { harness, endRun, type Harness } from '../orchestration/harness.ts'

export { endRun }
export type { Harness }

export const agent = (
  id: string,
  over: Partial<Extract<WorkflowNode, { kind: 'agent' }>> = {},
): WorkflowNode => ({
  id,
  kind: 'agent',
  label: id,
  agentId: 'builder',
  instruction: `Do ${id}`,
  retries: 0,
  onFailure: 'fail_run',
  ...over,
})
export const gate = (
  id: string,
  over: Partial<Extract<WorkflowNode, { kind: 'gate' }>> = {},
): WorkflowNode => ({
  id,
  kind: 'gate',
  label: id,
  question: `OK ${id}?`,
  onReject: 'stop_run',
  ...over,
})
export const end = (id = 'done'): WorkflowNode => ({ id, kind: 'end', label: id })
export const join = (id: string): WorkflowNode => ({ id, kind: 'join', label: id, mode: 'all' })
export const branch = (
  id: string,
  subject: string,
  rules: Extract<WorkflowNode, { kind: 'branch' }>['rules'],
): WorkflowNode => ({ id, kind: 'branch', label: id, subject, rules })
let edgeSeq = 0
export const edge = (from: string, to: string, port = 'ok'): WorkflowEdge => ({
  id: `e${++edgeSeq}`,
  from,
  port,
  to,
})
export const definition = (
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  inputs: WorkflowDefinition['inputs'] = [],
): WorkflowDefinition => ({ name: 'Test workflow', inputs, nodes, edges })

export const incarnationOf = (h: Harness, agentId: string): string =>
  (
    h.db.sqlite
      .prepare('SELECT incarnation_id AS i FROM agent_lifecycle WHERE agent_id = ?')
      .get(agentId) as { i: string } | undefined
  )?.i ?? 'untracked'

export function save(h: Harness, def: WorkflowDefinition): string {
  const created = h.db.tx((sqlite) =>
    createWorkflow(sqlite, def, new Date(h.scheduler.now()).toISOString()),
  )
  return created.workflowId
}

export async function start(
  h: Harness,
  def: WorkflowDefinition,
  over: Partial<WorkflowRunCreate> = {},
): Promise<string> {
  const workflowId = save(h, def)
  const agents = [...new Set(def.nodes.flatMap((n) => (n.kind === 'agent' ? [n.agentId] : [])))]
  const created = await h.orch.createWorkflowRun({
    workflowId,
    version: 1,
    inputs: {},
    agentMap: agents.map((agentId) => ({ agentId, incarnation: incarnationOf(h, agentId) })),
    gatePolicy: 'gates-only',
    unknownSpend: 'pause',
    maxConcurrentSteps: 2,
    stepEstimateUsd: 0.5,
    acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
    ...over,
  })
  return created.run.id
}

export const run = (h: Harness, id: string): WorkflowRunDetail => h.orch.workflowSnapshot(id).run
export const node = (h: Harness, id: string, nodeId: string) =>
  run(h, id).nodeStates.find((n) => n.nodeId === nodeId)!

export const wfHarness = harness

/** The Hermes run of a node's current attempt (the fake adapter holds steps whose instruction says `[fake:hold]`). */
export function runIdOf(h: Harness, id: string, nodeId: string): string | undefined {
  const n = node(h, id, nodeId)
  return run(h, id).attempts.find((a) => a.stepId === n.stepId)?.runId ?? undefined
}

export const A = '11111111-1111-4111-8111-111111111111'
export const B = '22222222-2222-4222-8222-222222222222'
export const seedAgent = (h: Harness, agentId: string, incarnation = A): void => {
  h.db.sqlite
    .prepare(
      "INSERT INTO agent_lifecycle (agent_id, incarnation_id, state) VALUES (?, ?, 'ready') ON CONFLICT (agent_id) DO UPDATE SET incarnation_id = excluded.incarnation_id",
    )
    .run(agentId, incarnation)
}
export const replaceAgent = (h: Harness, agentId: string, incarnation = B): void => {
  h.db.sqlite
    .prepare('UPDATE agent_lifecycle SET incarnation_id = ? WHERE agent_id = ?')
    .run(incarnation, agentId)
}

/** The node gate (or the assignment gate) that is open for the node, with the revisions a page would send. */
export function openGate(h: Harness, id: string, nodeId?: string) {
  const d = run(h, id)
  const node = d.nodeGates.find((g) => g.status === 'open' && (!nodeId || g.nodeId === nodeId))
  const assignment = d.assignmentGates.find(
    (g) => g.status === 'open' && (!nodeId || g.nodeId === nodeId),
  )
  const gate = node ?? assignment
  if (!gate) throw new Error('no open gate')
  return { gateId: gate.id, expectedRevision: gate.revision, orchestrationRevision: d.revision }
}
export async function decide(
  h: Harness,
  id: string,
  nodeId: string,
  decision: 'approve' | 'reject',
): Promise<void> {
  const g = openGate(h, id, nodeId)
  await h.orch.wfGateDecision(id, g.gateId, {
    decision,
    expectedRevision: g.expectedRevision,
    orchestrationRevision: g.orchestrationRevision,
  })
}
/** Which node's reply text to use: the payload header names the node as `(<id>: <label>)`. */
export const nodeOf = (input: string): string | undefined => /\(([a-z0-9_-]+): /.exec(input)?.[1]
export const replies =
  (byNode: Record<string, string>) => (req: { agentId: string; input: string }) => ({
    text: byNode[nodeOf(req.input) ?? ''] ?? 'The step is done.',
    tools: [] as string[],
  })
export const finishedRun = (h: Harness, id: string, ...statuses: string[]): boolean =>
  statuses.includes(run(h, id).status)
export const rawNode = (h: Harness, id: string, nodeId: string) =>
  h.rows<Record<string, unknown>>(
    'SELECT * FROM wf_nodes WHERE orchestration_id = ? AND node_id = ?',
    id,
    nodeId,
  )[0]!

/** Ends a node's Hermes run once the fake adapter has it running (its own start transition must not land afterwards). */
export async function finishNode(
  h: Harness,
  id: string,
  nodeId: string,
  status: 'completed' | 'failed' | 'cancelled',
  output = 'done',
): Promise<void> {
  await h.until(() => {
    const runId = runIdOf(h, id, nodeId)
    return (
      runId !== undefined &&
      h.rows<{ status: string }>('SELECT status FROM runs WHERE id = ?', runId)[0]?.status ===
        'running'
    )
  })
  await endRun(h, runIdOf(h, id, nodeId)!, status, output)
}
