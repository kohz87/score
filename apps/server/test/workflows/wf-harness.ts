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
