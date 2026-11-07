import {
  WorkflowRunEventsSchema,
  WorkflowRunSnapshotSchema,
  WorkflowRunSummarySchema,
} from '../packages/contract/src/index.ts'
import { releaseDefinition } from './workflow-fixtures-definitions.ts'
import { at, attempt, node, step } from './workflow-fixtures-helpers.ts'

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
