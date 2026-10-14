import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  WorkflowRunSnapshotSchema,
  type WorkflowDefinition,
  type WorkflowPreflight,
  type WorkflowRunCreate,
  type WorkflowRunDetail,
} from '@score/contract'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createWorkflow } from '../../src/domain/workflows/definitions.ts'
import { insertCodingAgent } from '../../src/runtimes/coding/store.ts'
import type { WorkerHarness } from './worker-harness.ts'

// 7.7c: workflows with coding step nodes on the worker harness (the real executor, coding runtime and unit backend, a
// harmless fake CLI). The helpers do what the start dialog does: look at preflight and approve what it shows.

export const wfRunOf = (h: WorkerHarness, id: string): WorkflowRunDetail =>
  WorkflowRunSnapshotSchema.parse(h.orch.workflowSnapshot(id)).run

/** Saves a definition as version 1 of a new workflow. */
export function saveWorkflow(h: WorkerHarness, def: WorkflowDefinition): string {
  return h.db.tx((sqlite) => createWorkflow(sqlite, def, new Date().toISOString())).workflowId
}

/** What the person approves after looking at preflight: every coding policy, and the reach where it goes beyond. */
export function consentFor(preflight: WorkflowPreflight): Partial<WorkflowRunCreate> {
  const policies = preflight.workers.flatMap((worker) =>
    worker.policyId === null ? [] : [[worker.agentId, worker.policyId] as const],
  )
  if (policies.length === 0) return {}
  return {
    codingPolicies: Object.fromEntries(policies),
    acknowledgeCodingReach: {
      policyIds: preflight.workers.flatMap((worker) =>
        worker.reachBeyondWorkspace && worker.policyId ? [worker.policyId] : [],
      ),
    },
  }
}

export async function startWorkflow(
  h: WorkerHarness,
  def: WorkflowDefinition,
  over: Partial<WorkflowRunCreate> = {},
  options: { workflowId?: string; consent?: boolean } = {},
): Promise<string> {
  const workflowId = options.workflowId ?? saveWorkflow(h, def)
  const preflight = await h.orch.workflowPreflight(workflowId, 1)
  const created = await h.orch.createWorkflowRun({
    workflowId,
    version: 1,
    inputs: {},
    agentMap: preflight.mapping.map(({ agentId, incarnation }) => ({ agentId, incarnation })),
    gatePolicy: 'gates-only',
    unknownSpend: 'pause',
    maxConcurrentSteps: 2,
    stepEstimateUsd: 0.5,
    acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
    ...(options.consent === false ? {} : consentFor(preflight)),
    ...over,
  })
  return created.run.id
}

/** A coding agent with its own workspace folder (so its policy id differs from the others'). */
export function addCodingAgent(
  h: WorkerHarness,
  id: string,
  runtime: 'claude-code' | 'codex' = 'claude-code',
  permission: 'read-only' | 'workspace-write' = 'workspace-write',
): void {
  const workspace = join(h.dir, `ws-${id}`)
  mkdirSync(workspace, { recursive: true })
  insertCodingAgent(h.db.sqlite, {
    id,
    name: id,
    role: '',
    runtime,
    workspace,
    permission,
    model: null,
    style: { color: '#19C39A', shape: 'hexagon' },
    createdAt: new Date().toISOString(),
  })
}
