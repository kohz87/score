import type { WorkflowDefinition } from '../packages/contract/src/index.ts'
import { fixtureNow } from './now-fixture.ts'

export const at = (seconds: number) =>
  new Date(Date.parse(fixtureNow) + seconds * 1000).toISOString()

export const agent = (id: string, label: string, instruction: string, retries = 0) => ({
  id,
  kind: 'agent' as const,
  label,
  agentId: id === 'draft' ? 'builder' : 'reviewer',
  instruction,
  retries,
  onFailure: 'fail_run' as const,
})

export const version = (def: WorkflowDefinition, used: boolean) => ({
  version: 1,
  hash: 'a'.repeat(64),
  createdAt: at(-86_400),
  used,
  bytes: JSON.stringify(def).length,
  nodes: def.nodes.length,
  maxSteps: def.nodes.reduce((n, node) => n + (node.kind === 'agent' ? node.retries + 1 : 0), 0),
})

export const summary = (id: string, def: WorkflowDefinition, used: boolean, active: number) => ({
  id,
  name: def.name,
  description: def.description ?? null,
  latestVersion: 1,
  versionCount: 1,
  used,
  agentIds: [...new Set(def.nodes.flatMap((n) => (n.kind === 'agent' ? [n.agentId] : [])))],
  createdAt: at(-86_400),
  updatedAt: at(-3600),
  activeRuns: active,
  archivedAt: null,
})

export const node = (
  nodeId: string,
  kind: string,
  state: string,
  patch: Record<string, unknown> = {},
) => ({
  nodeId,
  kind,
  state,
  revision: 2,
  waitingFor: null,
  attemptsUsed: 0,
  attemptsMax: kind === 'agent' ? 1 : 0,
  stepId: null,
  lineage: [],
  reason: null,
  output: null,
  outputTruncated: false,
  outputRevision: 0,
  verdict: null,
  gateId: null,
  refusals: null,
  remaps: 0,
  renewals: 0,
  canRetry: false,
  startedAt: null,
  endedAt: null,
  ...patch,
})

export const attempt = (
  id: string,
  stepId: string,
  agentId: string,
  patch: Record<string, unknown> = {},
) => ({
  id,
  kind: 'step',
  stepId,
  n: 1,
  agentId,
  sessionId: `orc-wfrun-1-${stepId}-1`,
  state: 'terminated',
  runId: null,
  retired: false,
  stopRequestedAt: null,
  stopAcknowledgedAt: null,
  terminatedAt: at(-200),
  evidence: 'completed',
  unknownReason: null,
  spendUsd: 0.21,
  spendComplete: true,
  abandonedAt: null,
  ...patch,
})

export const step = (
  id: string,
  agentId: string,
  instruction: string,
  patch: Record<string, unknown> = {},
) => ({
  id,
  agentId,
  instruction,
  after: [],
  replaces: null,
  status: 'succeeded',
  disposition: null,
  estimateUsd: 0.5,
  result: null,
  resultRevision: 1,
  gateId: null,
  attemptId: null,
  createdAt: at(-590),
  updatedAt: at(-60),
  ...patch,
})
