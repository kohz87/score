import {
  WorkflowDefinitionSchema,
  WorkflowPreflightSchema,
  WorkflowRunSnapshotSchema,
  type WorkflowDefinition,
} from '../packages/contract/src/index.ts'
import { releaseDefinition, workflowPreflight } from './workflow-fixtures-definitions.ts'
import { attempt, step } from './workflow-fixtures-helpers.ts'
import { runSnapshot } from './workflow-fixtures-runs.ts'

// ----- 7.7c: the same run with two coding steps, for the coding cards (neutral example agents coder-a and coder-b).
export const codingPolicyA = 'a'.repeat(64)
export const codingPolicyB = 'b'.repeat(64)
export const codingTeam = [
  {
    id: 'coder-a',
    name: 'coder-a',
    role: '',
    style: { color: '#19C39A', shape: 'hexagon' },
    status: 'idle',
    runtime: 'codex',
  },
  {
    id: 'coder-b',
    name: 'coder-b',
    role: '',
    style: { color: '#FFB61E', shape: 'triangle' },
    status: 'idle',
    runtime: 'claude-code',
  },
]
export const codingDefinition: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  ...releaseDefinition,
  nodes: releaseDefinition.nodes.map((n) =>
    n.id === 'draft'
      ? { ...n, agentId: 'coder-a' }
      : n.id === 'review'
        ? { ...n, agentId: 'coder-b' }
        : n,
  ),
})

/**
 * The release run, but the draft is a coding step of coder-a that waits for a decision of the person and the review a
 * coding step of coder-b. `needsYou` is what the run asks for; `draft` patches the draft's node state.
 */
export function codingRunSnapshot(
  needsYou: unknown[],
  draft: Record<string, unknown> = {},
  coding: Record<string, unknown> = {},
) {
  const base = structuredClone(runSnapshot) as unknown as { run: Record<string, unknown> }
  const run = base.run as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- fixture patching
  return WorkflowRunSnapshotSchema.parse({
    ...base,
    run: {
      ...run,
      definition: codingDefinition,
      needsYou,
      nodeGates: [],
      agentMap: [
        { agentId: 'coder-a', incarnation: 'coder-a', status: 'current' },
        { agentId: 'coder-b', incarnation: 'coder-b', status: 'current' },
      ],
      nodeStates: run['nodeStates'].map((n: Record<string, unknown>) =>
        n['nodeId'] === 'draft'
          ? {
              ...n,
              state: 'running',
              revision: 4,
              attemptsUsed: 1,
              output: null,
              outputRevision: 0,
              endedAt: null,
              ...draft,
            }
          : n['nodeId'] === 'review'
            ? {
                ...n,
                state: 'waiting',
                verdict: null,
                output: null,
                outputRevision: 0,
                endedAt: null,
              }
            : n['nodeId'] === 'approve'
              ? { ...n, state: 'waiting', gateId: null }
              : n,
      ),
      steps: [
        step('st-draft', 'coder-a', 'Write the release notes about the 2.4 release.', {
          status: 'blocked',
          disposition: 'agent_changed',
          result: null,
          resultRevision: 0,
          attemptId: 'wa1',
        }),
      ],
      attempts: [
        attempt('wa1', 'st-draft', 'coder-a', {
          state: 'created',
          terminatedAt: null,
          evidence: null,
          spendUsd: 0,
        }),
      ],
      coding: {
        workers: [
          {
            agentId: 'coder-a',
            runtime: 'codex',
            policyId: codingPolicyA,
            reach: 'Reads and edits files in /work/site.',
            reachBeyondWorkspace: false,
          },
          {
            agentId: 'coder-b',
            runtime: 'claude-code',
            policyId: codingPolicyB,
            reach: 'Reads and edits files in /work/site.',
            reachBeyondWorkspace: false,
          },
        ],
        codingSteps: 4,
        used: 4,
        acceptedUnknownCost: [],
        unknownSpend: 'pause',
        ...coding,
      },
    },
  })
}

/** The preflight of that workflow: what each coding agent can do now. */
export const codingPreflight = WorkflowPreflightSchema.parse({
  ...workflowPreflight,
  mapping: [
    { agentId: 'coder-a', name: 'coder-a', incarnation: 'coder-a' },
    { agentId: 'coder-b', name: 'coder-b', incarnation: 'coder-b' },
  ],
  workers: [
    {
      agentId: 'coder-a',
      runtime: 'codex',
      readiness: 'ready',
      detail: null,
      policyId: codingPolicyB,
      reach:
        'Reads any file you can read, not only the ones in /work/site. It changes files only in /work/site.',
      reachBeyondWorkspace: true,
    },
    {
      agentId: 'coder-b',
      runtime: 'claude-code',
      readiness: 'ready',
      detail: null,
      policyId: codingPolicyB,
      reach: 'Reads and edits files in /work/site.',
      reachBeyondWorkspace: false,
    },
  ],
  defaults: { ...workflowPreflight.defaults, codingSteps: 4 },
})
