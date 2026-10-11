import type * as contract from '../src/index.ts'
import { ORCH_ACKNOWLEDGEMENT_TEXT } from '../src/index.ts'
import * as f from './fixtures.ts'

// Valid and invalid fixtures for contract §15 (schemas.test.ts requires a pair for every exported schema).

const at = f.at
const agentNode = {
  id: 'draft',
  kind: 'agent',
  label: 'Draft',
  agentId: 'builder',
  instruction: 'Write about {{inputs.topic}}',
  retries: 1,
  onFailure: 'fail_run',
} as const
const gateNode = {
  id: 'approve',
  kind: 'gate',
  label: 'Approve',
  question: 'Ship it?',
  onReject: 'stop_run',
} as const
const branchNode = {
  id: 'route',
  kind: 'branch',
  label: 'Route',
  subject: 'draft',
  rules: [{ id: 'good', when: { kind: 'verdict', is: 'passed' } }],
} as const
const joinNode = { id: 'merge', kind: 'join', label: 'Merge', mode: 'all' } as const
const endNode = { id: 'done', kind: 'end', label: 'Done' } as const
const edge = { id: 'e1', from: 'draft', port: 'ok', to: 'approve' } as const
const input = { name: 'topic', label: 'Topic', required: true, maxChars: 200 } as const
export const workflowDefinition = {
  name: 'Release notes',
  inputs: [input],
  nodes: [agentNode, gateNode, endNode],
  edges: [edge, { id: 'e2', from: 'approve', port: 'ok', to: 'done' }],
} as const
const validation = {
  ok: false,
  issues: [
    {
      code: 'unrouted_failure',
      severity: 'error',
      nodeId: 'draft',
      edgeId: null,
      field: null,
      message: 'Draft has no failed edge',
    },
  ],
  stats: { nodes: 3, edges: 2, maxSteps: 2, bytes: 400 },
} as const
const versionSummary = {
  version: 2,
  hash: 'a'.repeat(64),
  createdAt: at,
  used: false,
  bytes: 400,
  nodes: 3,
  maxSteps: 2,
} as const
const workflowSummary = {
  id: 'wf-1',
  name: 'Release notes',
  description: null,
  latestVersion: 2,
  versionCount: 2,
  used: true,
  agentIds: ['builder'],
  createdAt: at,
  updatedAt: at,
  activeRuns: 0,
} as const
const version = { ...versionSummary, workflowId: 'wf-1', definition: workflowDefinition } as const
const verdict = {
  verdict: 'passed',
  reason: 'ok',
  source: 'runtime',
  outputTruncated: false,
} as const
const refusals = {
  consecutive: 1,
  lifetime: 3,
  lastGeneration: 3,
  lastState: 'refused',
  nextTryAt: null,
} as const
export const nodeView = {
  nodeId: 'draft',
  kind: 'agent',
  state: 'running',
  revision: 2,
  waitingFor: null,
  attemptsUsed: 1,
  attemptsMax: 2,
  stepId: 's1',
  lineage: ['s1'],
  reason: null,
  output: null,
  outputTruncated: false,
  outputRevision: 0,
  verdict: null,
  gateId: null,
  refusals: null,
  remaps: 0,
  canRetry: false,
  startedAt: at,
  endedAt: null,
} as const
const tokenView = {
  id: 't1',
  edgeId: 'e1',
  kind: 'ok',
  producedBy: 'draft',
  producedAttempt: 1,
  consumedBy: null,
  createdAt: at,
} as const
const consumedView = {
  consumer: 'approve',
  consumerAttempt: 1,
  producer: 'draft',
  producerAttempt: 1,
  outputRevision: 1,
  kind: 'output',
  eligible: true,
} as const
export const nodeGateView = {
  id: 'g1',
  kind: 'node',
  nodeId: 'approve',
  status: 'open',
  payload: {
    question: 'Ship it?',
    consumed: [{ nodeId: 'draft', outputRevision: 1, output: 'text', truncated: false }],
    nodeRevision: 2,
    runRevision: 4,
  },
  payloadHash: 'h',
  revision: 1,
  note: null,
  createdAt: at,
  decidedAt: null,
} as const
const assignmentGateView = {
  id: 'g2',
  stepId: 's1',
  requestedBy: 'policy',
  status: 'open',
  payload: {
    agentId: 'builder',
    agentIncarnation: 'inc-1',
    instruction: 'Write it',
    after: [],
    replaces: null,
    estimateUsd: 0.5,
    dependencyRevisions: {},
  },
  payloadHash: 'h',
  revision: 1,
  note: null,
  createdAt: at,
  decidedAt: null,
  nodeId: 'draft',
} as const
const remapPlanItem = {
  nodeId: 'draft',
  retiresAttemptId: 'a1',
  payloadHash: 'h',
  payload: 'text',
} as const
const needsYou = [
  { kind: 'gate', gateId: 'g1', gateKind: 'node', nodeId: 'approve' },
  { kind: 'retry', nodeId: 'draft', attemptsLeft: 1 },
] as const
const spendEvidence = {
  attemptId: 'a1',
  attributed: true,
  lineageComplete: false,
  fresh: true,
  costScope: 'tokens',
} as const
const storage = {
  reserveBytes: 1000,
  storedBytes: 10,
  protectedBytes: 65536,
  items: [{ kind: 'receipts', rows: 2, bytes: 100 }],
  compactedControlRecords: 0,
} as const
export const runDetail = {
  ...f.workflowRunSummary,
  definition: workflowDefinition,
  inputs: { topic: 'v2' },
  agentMap: [{ agentId: 'builder', incarnation: 'inc-1', status: 'current' }],
  plannerGeneration: 2,
  nodeStates: [nodeView],
  tokens: [tokenView],
  consumed: [consumedView],
  nodeGates: [nodeGateView],
  assignmentGates: [assignmentGateView],
  steps: [],
  attempts: [],
  deadlineAt: null,
  maxSteps: 2,
  maxConcurrentSteps: 2,
  stepEstimateUsd: 0.5,
  budget: {
    limitUsd: null,
    settledUsd: 0,
    provisionalUsd: 0,
    reservedUsd: 0,
    remainingUsd: null,
    unknownSpend: true,
    complete: false,
  },
  unknownSpend: 'pause',
  spend: {
    settled: false,
    note: "spend not settled — Hermes doesn't report complete costs",
    evidence: [spendEvidence],
  },
  cancelFence: [],
  waiverAt: null,
  acknowledgedAt: at,
  endReason: null,
  storage,
} as const
const event = {
  id: 'e-1',
  at,
  kind: 'node_state',
  stepId: null,
  attemptId: null,
  tool: null,
  verdict: null,
  code: null,
  summary: 'Draft is ready',
  nodeId: 'draft',
  edgeId: null,
} as const
const preflightCheck = { id: 'definition', status: 'ok', message: 'Valid' } as const
const preflight = {
  ok: true,
  checks: [preflightCheck],
  mapping: [{ agentId: 'builder', name: 'Builder', incarnation: 'inc-1' }],
  gatePolicyNotes: { 'gates-only': 'Only gates stop.', 'every-step': 'Every step asks.' },
  acknowledgementText: ORCH_ACKNOWLEDGEMENT_TEXT,
  spendNote: 'Hermes reports tokens, often not dollars.',
  maxSteps: 2,
  reserveBytes: 1000,
  defaults: { gatePolicy: 'gates-only', maxConcurrentSteps: 2, stepEstimateUsd: 0.5 },
} as const
const runCreate = {
  workflowId: 'wf-1',
  version: 1,
  inputs: { topic: 'v2' },
  agentMap: [{ agentId: 'builder', incarnation: 'inc-1' }],
  gatePolicy: 'gates-only',
  unknownSpend: 'pause',
  maxConcurrentSteps: 2,
  stepEstimateUsd: 0.5,
  acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
} as const
const portable = {
  name: 'Release notes',
  inputs: [input],
  nodes: [
    {
      id: 'draft',
      kind: 'agent',
      label: 'Draft',
      agent: { name: 'Builder', role: null },
      instruction: 'Write',
      retries: 0,
      onFailure: 'fail_run',
    },
    endNode,
  ],
  edges: [{ id: 'e1', from: 'draft', port: 'ok', to: 'done' }],
} as const

type Case = readonly [keyof typeof contract, unknown, unknown]
export const workflowCases = [
  ['NodeIdSchema', 'draft', 'Bad Id'],
  ['PortSchema', 'ok', 'Not A Port'],
  ['InputNameSchema', 'topic', 'Topic'],
  ['WorkflowInputSchema', input, { ...input, maxChars: 0 }],
  ['AgentNodeSchema', agentNode, { ...agentNode, retries: 3 }],
  ['GateNodeSchema', gateNode, { ...gateNode, question: '' }],
  ['BranchConditionSchema', { kind: 'outcome', is: 'failed' }, { kind: 'outcome', is: 'maybe' }],
  ['BranchRuleSchema', branchNode.rules[0], { id: 'good' }],
  ['BranchNodeSchema', branchNode, { ...branchNode, rules: [] }],
  ['JoinNodeSchema', joinNode, { ...joinNode, mode: 'first' }],
  ['EndNodeSchema', endNode, { ...endNode, kind: 'agent' }],
  ['WorkflowNodeSchema', gateNode, { ...gateNode, kind: 'loop' }],
  ['WorkflowEdgeSchema', edge, { ...edge, to: '' }],
  [
    'WorkflowLayoutSchema',
    { nodes: { a: { x: 16, y: 32 } } },
    { nodes: { a: { x: Number.NaN, y: 0 } } },
  ],
  ['WorkflowDefinitionSchema', workflowDefinition, { ...workflowDefinition, nodes: [] }],
  ['ValidationCodeSchema', 'cycle', 'nope'],
  ['ValidationIssueSchema', validation.issues[0], { ...validation.issues[0], severity: 'fatal' }],
  ['ValidationResultSchema', validation, { ok: true }],
  ['WorkflowVersionSummarySchema', versionSummary, { ...versionSummary, hash: 'short' }],
  ['WorkflowSummarySchema', workflowSummary, { id: 'wf-1' }],
  [
    'WorkflowListSchema',
    {
      items: [workflowSummary],
      inventory: {
        definitions: 1,
        versions: 2,
        bytes: 800,
        maxDefinitions: 200,
        maxVersionsPerDefinition: 20,
      },
    },
    { items: [] },
  ],
  ['WorkflowVersionSchema', version, { ...version, definition: {} }],
  [
    'WorkflowDetailSchema',
    { ...workflowSummary, versions: [versionSummary], latest: version },
    { ...workflowSummary },
  ],
  [
    'WorkflowValidateSchema',
    { definition: workflowDefinition },
    { definition: workflowDefinition, extra: 1 },
  ],
  ['WorkflowCreateSchema', { definition: workflowDefinition }, {}],
  [
    'WorkflowVersionCreateSchema',
    { baseVersion: 1, definition: workflowDefinition },
    { definition: workflowDefinition },
  ],
  ['PortableAgentSchema', { name: 'Builder', role: null }, { name: '' }],
  ['PortableNodeSchema', portable.nodes[0], { ...portable.nodes[0], agent: undefined }],
  ['WorkflowExportRequestSchema', { removePaths: ['nodes[0].instruction'] }, { removePaths: [''] }],
  [
    'WorkflowExportSchema',
    {
      format: 'score.workflow/1',
      scrubbed: true,
      workflowId: 'wf-1',
      version: 1,
      portable,
      changes: [{ path: 'nodes[0].instruction', before: 'sk-x', after: '[redacted]' }],
      validation,
    },
    { format: 'other', scrubbed: true },
  ],
  ['NodeStateSchema', 'gate_open', 'paused'],
  ['WaitingForSchema', 'refusal_limit', 'sleepy'],
  ['TokenKindSchema', 'skip', 'maybe'],
  ['GraphOutcomeSchema', 'reached_end', 'succeeded'],
  ['VerdictRecordSchema', verdict, { ...verdict, source: 'recovered' }],
  ['NodeRefusalsSchema', refusals, { ...refusals, lastState: 'lost' }],
  ['NodeViewSchema', nodeView, { ...nodeView, revision: 0 }],
  ['TokenViewSchema', tokenView, { ...tokenView, kind: 'maybe' }],
  ['ConsumedViewSchema', consumedView, { ...consumedView, kind: 'guess' }],
  ['NodeGateViewSchema', nodeGateView, { ...nodeGateView, kind: 'assignment' }],
  ['AssignmentGateViewSchema', assignmentGateView, { ...assignmentGateView, nodeId: 'Bad Id' }],
  ['RemapPlanItemSchema', remapPlanItem, { ...remapPlanItem, payload: undefined }],
  ['WorkflowNeedsYouSchema', needsYou[0], { kind: 'retry', nodeId: 'draft' }],
  [
    'AgentMapEntrySchema',
    { agentId: 'builder', incarnation: 'inc-1', status: 'changed' },
    { agentId: 'builder', incarnation: 'inc-1', status: 'gone' },
  ],
  ['SpendEvidenceSchema', spendEvidence, { ...spendEvidence, costScope: 'euros' }],
  ['StorageInventorySchema', storage, { ...storage, items: [{ kind: 'misc', rows: 1, bytes: 1 }] }],
  ['WorkflowGatePolicySchema', 'every-step', 'lead-asks'],
  ['WorkflowRunSummarySchema', f.workflowRunSummary, { id: 'x' }],
  [
    'WorkflowRunListSchema',
    { asOfSeq: 1, items: [f.workflowRunSummary] },
    { items: [f.workflowRunSummary] },
  ],
  ['WorkflowRunDetailSchema', runDetail, { ...runDetail, nodeStates: [{}] }],
  ['WorkflowRunSnapshotSchema', { asOfSeq: 3, run: runDetail }, { asOfSeq: 3 }],
  ['WorkflowEventKindSchema', 'graph_end', 'nope'],
  ['WorkflowEventSchema', event, { ...event, nodeId: 'Bad Id' }],
  ['WorkflowRunEventsSchema', { asOfSeq: 1, events: [event] }, { events: [event] }],
  ['WorkflowPreflightCheckSchema', preflightCheck, { ...preflightCheck, id: 'lead_ready' }],
  ['WorkflowPreflightSchema', preflight, { ...preflight, acknowledgementText: 'ok' }],
  ['WorkflowRunCreateSchema', runCreate, { ...runCreate, acknowledgement: { text: 'ok' } }],
  [
    'WorkflowRunCreatedSchema',
    { run: f.workflowRunSummary, preflight },
    { run: f.workflowRunSummary },
  ],
  [
    'WorkflowRetryDecisionSchema',
    { expectedNodeRevision: 2, orchestrationRevision: 5, acknowledge: true },
    { expectedNodeRevision: 2, orchestrationRevision: 5, acknowledge: false },
  ],
  [
    'WorkflowTryAgainDecisionSchema',
    { expectedNodeRevision: 2, orchestrationRevision: 5 },
    { orchestrationRevision: 5 },
  ],
  [
    'WorkflowRemapDecisionSchema',
    {
      agentId: 'builder',
      frozenIncarnation: 'a',
      currentIncarnation: 'b',
      orchestrationRevision: 3,
      acknowledge: true,
      plan: [{ nodeId: 'draft', payloadHash: 'h' }],
    },
    {
      agentId: 'builder',
      frozenIncarnation: 'a',
      currentIncarnation: 'b',
      orchestrationRevision: 3,
    },
  ],
  ['PlannerVerbSchema', 'assign', 'reassign'],
  ['PlannerReceiptSchema', { status: 'refused', code: 'payload_too_large' }, { status: 'later' }],
] as const satisfies readonly Case[]
