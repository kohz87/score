import {
  ValidationResultSchema,
  WorkflowDefinitionSchema,
  WorkflowDetailSchema,
  WorkflowListSchema,
  WorkflowPreflightSchema,
  WorkflowRunEventsSchema,
  WorkflowRunListSchema,
  WorkflowRunSnapshotSchema,
  WorkflowRunSummarySchema,
  WorkflowVersionSchema,
  type WorkflowDefinition,
} from '../packages/contract/src/index.ts'
import { fixtureNow } from './now-fixture.ts'

// A workflow and a run caught mid-way, for the 7.1b component tests and visual baselines: the draft and its review are
// done, the gate waits for the person, the branch and both ends have not been reached. Neutral example agents.
const at = (seconds: number) => new Date(Date.parse(fixtureNow) + seconds * 1000).toISOString()

const agent = (id: string, label: string, instruction: string, retries = 0) => ({
  id,
  kind: 'agent' as const,
  label,
  agentId: id === 'draft' ? 'builder' : 'reviewer',
  instruction,
  retries,
  onFailure: 'fail_run' as const,
})

export const releaseDefinition: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  name: 'Release notes',
  description: 'Draft the notes, have them reviewed, ask before publishing.',
  inputs: [{ name: 'topic', label: 'Topic', required: true, maxChars: 500 }],
  nodes: [
    agent('draft', 'Draft the notes', 'Write the release notes about {{inputs.topic}}.', 1),
    agent(
      'review',
      'Review the draft',
      'Review this draft and end with a verdict: {{nodes.draft.output}}',
    ),
    {
      id: 'approve',
      kind: 'gate',
      label: 'Approve the draft',
      question: 'Is the reviewed draft good enough to publish?',
      onReject: 'stop_run',
    },
    {
      id: 'passed',
      kind: 'branch',
      label: 'Passed review?',
      subject: 'review',
      rules: [{ id: 'ok', when: { kind: 'verdict', is: 'passed' } }],
    },
    { id: 'publish', kind: 'end', label: 'Published' },
    agent('repair', 'Repair the draft', 'Fix what the review found: {{nodes.review.output}}'),
    { id: 'repaired', kind: 'end', label: 'Repaired' },
  ],
  edges: [
    { id: 'e1', from: 'draft', port: 'ok', to: 'review' },
    { id: 'e2', from: 'review', port: 'ok', to: 'approve' },
    { id: 'e3', from: 'approve', port: 'ok', to: 'passed' },
    { id: 'e4', from: 'passed', port: 'ok', to: 'publish' },
    { id: 'e5', from: 'passed', port: 'default', to: 'repair' },
    { id: 'e6', from: 'repair', port: 'ok', to: 'repaired' },
  ],
})

/** An unfinished draft of a workflow, for the editor baselines: problems on a node, a connection and the whole. */
export const unfinishedDefinition: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  name: 'Release checks (draft)',
  inputs: [],
  nodes: [
    { ...agent('build', 'Build it', 'Build the release.'), onFailure: 'route' },
    {
      id: 'ask',
      kind: 'gate',
      label: 'Check with me',
      question: 'Ship it?',
      onReject: 'stop_run',
    },
    {
      id: 'fix',
      kind: 'agent',
      label: 'Fix it',
      agentId: 'builder',
      instruction: 'Fix {{nodes.build.output}}',
      retries: 0,
      onFailure: 'fail_run',
    },
  ],
  edges: [
    { id: 'e1', from: 'build', port: 'ok', to: 'ask' },
    { id: 'e2', from: 'ask', port: 'ok', to: 'fix' },
  ],
})

export const unfinishedValidation = ValidationResultSchema.parse({
  ok: false,
  stats: { nodes: 3, edges: 2, maxSteps: 2, bytes: 600 },
  issues: [
    {
      code: 'unrouted_failure',
      severity: 'error',
      nodeId: 'build',
      edgeId: null,
      field: null,
      message:
        'Build it says a failure goes to its own path, but nothing is connected to "when it fails".',
    },
    {
      code: 'no_end',
      severity: 'error',
      nodeId: null,
      edgeId: null,
      field: null,
      message: 'The workflow has no end.',
    },
    {
      code: 'template_not_ancestor',
      severity: 'error',
      nodeId: 'fix',
      edgeId: null,
      field: 'instruction',
      message: 'Fix it reads Build it, but Build it is not connected to lead into it.',
    },
  ],
})

export const okValidation = ValidationResultSchema.parse({
  ok: true,
  stats: { nodes: 7, edges: 6, maxSteps: 4, bytes: 1500 },
  issues: [],
})

const version = (def: WorkflowDefinition, used: boolean) => ({
  version: 1,
  hash: 'a'.repeat(64),
  createdAt: at(-86_400),
  used,
  bytes: JSON.stringify(def).length,
  nodes: def.nodes.length,
  maxSteps: def.nodes.reduce((n, node) => n + (node.kind === 'agent' ? node.retries + 1 : 0), 0),
})

const summary = (id: string, def: WorkflowDefinition, used: boolean, active: number) => ({
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
})

export const releaseVersion = WorkflowVersionSchema.parse({
  ...version(releaseDefinition, true),
  workflowId: 'wf-release',
  definition: releaseDefinition,
})
export const unfinishedVersion = WorkflowVersionSchema.parse({
  ...version(unfinishedDefinition, false),
  workflowId: 'wf-draft',
  definition: unfinishedDefinition,
})

/** The same workflow drawn by hand (PLAN 7.1c): a loop back under itself instead of the automatic columns. Not in the list. */
export const drawnDefinition: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  ...releaseDefinition,
  name: 'Release notes (drawn)',
  layout: {
    nodes: {
      draft: { x: 16, y: 32 },
      review: { x: 256, y: 32 },
      approve: { x: 496, y: 32 },
      passed: { x: 704, y: 144 },
      publish: { x: 496, y: 256 },
      repair: { x: 16, y: 256 },
      repaired: { x: 256, y: 352 },
    },
  },
})
export const drawnVersion = WorkflowVersionSchema.parse({
  ...version(drawnDefinition, false),
  workflowId: 'wf-drawn',
  definition: drawnDefinition,
})
export const drawnDetail = WorkflowDetailSchema.parse({
  ...summary('wf-drawn', drawnDefinition, false, 0),
  versions: [version(drawnDefinition, false)],
  latest: drawnVersion,
})

export const workflowList = WorkflowListSchema.parse({
  items: [
    summary('wf-release', releaseDefinition, true, 1),
    summary('wf-draft', unfinishedDefinition, false, 0),
  ],
  inventory: {
    definitions: 2,
    versions: 2,
    bytes: 2400,
    maxDefinitions: 200,
    maxVersionsPerDefinition: 20,
  },
})

export const releaseDetail = WorkflowDetailSchema.parse({
  ...summary('wf-release', releaseDefinition, true, 1),
  versions: [version(releaseDefinition, true)],
  latest: releaseVersion,
})
export const unfinishedDetail = WorkflowDetailSchema.parse({
  ...summary('wf-draft', unfinishedDefinition, false, 0),
  versions: [version(unfinishedDefinition, false)],
  latest: unfinishedVersion,
})

export const workflowPreflight = WorkflowPreflightSchema.parse({
  ok: true,
  checks: [
    { id: 'definition', status: 'ok', message: 'The workflow is valid' },
    { id: 'agents', status: 'ok', message: 'builder and reviewer are ready' },
    { id: 'capacity', status: 'ok', message: 'There is room for another run' },
  ],
  mapping: [
    { agentId: 'builder', name: 'builder', incarnation: '4f7c1d2e-8a3b-4c5d-9e6f-0a1b2c3d4e5f' },
    { agentId: 'reviewer', name: 'reviewer', incarnation: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' },
  ],
  gatePolicyNotes: {
    'gates-only': 'Only the gates you drew stop for you.',
    'every-step': 'Every agent step also waits for your approval before it starts.',
  },
  acknowledgementText:
    "Score controls the work it starts (exchanges and steps) and can stop those runs; agents may still use other tools and start background work Score can't see or stop.",
  spendNote:
    'Hermes reports tokens, often not dollars; unknown spend is shown as unknown, never zero.',
  maxSteps: 5,
  reserveBytes: 2_000_000,
  defaults: { gatePolicy: 'gates-only', maxConcurrentSteps: 2, stepEstimateUsd: 0.5 },
})

const needsYou = [
  { kind: 'gate' as const, gateId: 'wg-1', gateKind: 'node' as const, nodeId: 'approve' },
]

export const runSummary = WorkflowRunSummarySchema.parse({
  id: 'wfrun-1',
  title: 'Release notes: the 2.4 release',
  workflowId: 'wf-release',
  workflowName: 'Release notes',
  version: 1,
  status: 'running',
  pauseReason: null,
  graphOutcome: null,
  outcomeNote: null,
  gatePolicy: 'gates-only',
  roomId: 'room-activity-feed',
  briefId: 'brief-wfrun-1',
  revision: 14,
  ownership: 'owned',
  nodes: {
    total: 7,
    waiting: 4,
    ready: 0,
    running: 0,
    gateOpen: 1,
    succeeded: 2,
    failed: 0,
    skipped: 0,
    unresolved: 0,
  },
  needsYou,
  unconfirmed: 0,
  rerunOf: null,
  createdAt: at(-600),
  updatedAt: at(-30),
  endedAt: null,
})

const node = (
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

const attempt = (
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

const step = (
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

const draftOutput =
  'Release notes 2.4\n\nAdded: dark theme, workflows.\nFixed: 14 bugs.\nRemoved: the old import.'

export const runSnapshot = WorkflowRunSnapshotSchema.parse({
  asOfSeq: 52,
  run: {
    ...runSummary,
    definition: releaseDefinition,
    inputs: { topic: 'the 2.4 release' },
    agentMap: [
      {
        agentId: 'builder',
        incarnation: '4f7c1d2e-8a3b-4c5d-9e6f-0a1b2c3d4e5f',
        status: 'current',
      },
      {
        agentId: 'reviewer',
        incarnation: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        status: 'current',
      },
    ],
    plannerGeneration: 3,
    nodeStates: [
      node('draft', 'agent', 'succeeded', {
        attemptsUsed: 1,
        attemptsMax: 2,
        stepId: 'st-draft',
        lineage: ['st-draft'],
        output: draftOutput,
        outputRevision: 1,
        startedAt: at(-560),
        endedAt: at(-400),
      }),
      node('review', 'agent', 'succeeded', {
        attemptsUsed: 1,
        attemptsMax: 1,
        stepId: 'st-review',
        lineage: ['st-review'],
        output:
          'Looks right. Two typos fixed.\n```score-verdict\n{"verdict":"passed","reason":"complete and accurate"}\n```',
        outputRevision: 1,
        verdict: {
          verdict: 'passed',
          reason: 'complete and accurate',
          source: 'runtime',
          outputTruncated: false,
        },
        startedAt: at(-390),
        endedAt: at(-60),
      }),
      node('approve', 'gate', 'gate_open', { gateId: 'wg-1', startedAt: at(-55) }),
      node('passed', 'branch', 'waiting'),
      node('publish', 'end', 'waiting'),
      node('repair', 'agent', 'waiting', { attemptsMax: 1 }),
      node('repaired', 'end', 'waiting'),
    ],
    tokens: [
      {
        id: 't0',
        edgeId: 'start:draft',
        kind: 'ok',
        producedBy: '__start',
        producedAttempt: 0,
        consumedBy: 'draft',
        createdAt: at(-570),
      },
      {
        id: 't1',
        edgeId: 'e1',
        kind: 'ok',
        producedBy: 'draft',
        producedAttempt: 1,
        consumedBy: 'review',
        createdAt: at(-400),
      },
      {
        id: 't2',
        edgeId: 'e2',
        kind: 'ok',
        producedBy: 'review',
        producedAttempt: 1,
        consumedBy: 'approve',
        createdAt: at(-60),
      },
    ],
    consumed: [
      {
        consumer: 'review',
        consumerAttempt: 1,
        producer: 'draft',
        producerAttempt: 1,
        outputRevision: 1,
        kind: 'output',
        eligible: true,
      },
    ],
    nodeGates: [
      {
        id: 'wg-1',
        kind: 'node',
        nodeId: 'approve',
        status: 'open',
        payload: {
          question: 'Is the reviewed draft good enough to publish?',
          consumed: [
            {
              nodeId: 'review',
              outputRevision: 1,
              output: 'Looks right. Two typos fixed.',
              truncated: false,
            },
          ],
          nodeRevision: 2,
          runRevision: 13,
        },
        payloadHash: 'wg1hash',
        revision: 1,
        note: null,
        createdAt: at(-55),
        decidedAt: null,
      },
    ],
    assignmentGates: [],
    steps: [
      step('st-draft', 'builder', 'Write the release notes about the 2.4 release.', {
        result: draftOutput,
        attemptId: 'wa1',
      }),
      step('st-review', 'reviewer', 'Review this draft and end with a verdict.', {
        result: 'Looks right.',
        attemptId: 'wa2',
      }),
    ],
    attempts: [
      attempt('wa1', 'st-draft', 'builder'),
      attempt('wa2', 'st-review', 'reviewer', { terminatedAt: at(-60) }),
    ],
    deadlineAt: null,
    maxSteps: 5,
    maxConcurrentSteps: 2,
    stepEstimateUsd: 0.5,
    budget: {
      limitUsd: 5,
      settledUsd: 0.42,
      provisionalUsd: 0,
      reservedUsd: 1,
      remainingUsd: 3.58,
      unknownSpend: false,
      complete: true,
    },
    unknownSpend: 'pause',
    spend: { settled: true, note: 'spend settled', evidence: [] },
    cancelFence: [],
    waiverAt: null,
    acknowledgedAt: at(-600),
    endReason: null,
    storage: {
      reserveBytes: 2_000_000,
      storedBytes: 9000,
      protectedBytes: 65536,
      items: [],
      compactedControlRecords: 0,
    },
  },
})

const ev = (i: number, seconds: number, patch: Record<string, unknown>) => ({
  id: `h${i}`,
  at: at(seconds),
  stepId: null,
  attemptId: null,
  tool: null,
  verdict: null,
  code: null,
  nodeId: null,
  edgeId: null,
  summary: '',
  ...patch,
})

export const runEvents = WorkflowRunEventsSchema.parse({
  asOfSeq: 52,
  events: [
    ev(1, -600, { kind: 'run_started', summary: 'created' }),
    ev(2, -570, { kind: 'token', edgeId: 'start:draft', summary: 'token ok on start:draft' }),
    ev(3, -565, {
      kind: 'node_state',
      nodeId: 'draft',
      verdict: 'running',
      summary: 'draft: running',
    }),
    ev(4, -400, {
      kind: 'node_state',
      nodeId: 'draft',
      verdict: 'succeeded',
      summary: 'draft: succeeded',
    }),
    ev(5, -400, { kind: 'token', edgeId: 'e1', nodeId: 'draft', summary: 'token ok on e1' }),
    ev(6, -395, {
      kind: 'node_state',
      nodeId: 'review',
      verdict: 'running',
      summary: 'review: running',
    }),
    ev(7, -60, {
      kind: 'node_state',
      nodeId: 'review',
      verdict: 'succeeded',
      summary: 'review: succeeded',
    }),
    ev(8, -60, { kind: 'token', edgeId: 'e2', nodeId: 'review', summary: 'token ok on e2' }),
    ev(9, -55, {
      kind: 'node_state',
      nodeId: 'approve',
      verdict: 'gate_open',
      summary: 'approve: gate open',
    }),
  ],
})

export const workflowFixtures: Record<string, unknown> = {
  '/api/workflows': workflowList,
  '/api/workflows/wf-release': releaseDetail,
  '/api/workflows/wf-draft': unfinishedDetail,
  '/api/workflows/wf-drawn': drawnDetail,
  '/api/workflows/wf-release/versions/1': releaseVersion,
  '/api/workflows/wf-draft/versions/1': unfinishedVersion,
  '/api/workflows/wf-drawn/versions/1': drawnVersion,
  '/api/workflow-runs': WorkflowRunListSchema.parse({ asOfSeq: 52, items: [runSummary] }),
  '/api/workflow-runs/wfrun-1': runSnapshot,
  '/api/workflow-runs/wfrun-1/events': runEvents,
  '/api/workflow-runs/preflight?workflowId=wf-release&version=1': workflowPreflight,
}
