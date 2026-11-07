import {
  ValidationResultSchema,
  WorkflowDefinitionSchema,
  WorkflowDetailSchema,
  WorkflowListSchema,
  WorkflowPreflightSchema,
  WorkflowVersionSchema,
  type WorkflowDefinition,
} from '../packages/contract/src/index.ts'
import { agent, summary, version } from './workflow-fixtures-helpers.ts'

// A workflow and a run caught mid-way, for the 7.1b component tests and visual baselines: the draft and its review are
// done, the gate waits for the person, the branch and both ends have not been reached. Neutral example agents.
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
  issues: [],
  workers: [],
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
