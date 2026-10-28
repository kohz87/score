import type { AgentSummary, OrchEvent, OrchestrationDetail } from '@score/contract'
import { orchestrationSnapshot } from '../../../../../e2e/orchestration-fixtures.ts'

// Test data for the job map: the shared orchestration fixture plus the 3.15 layers (neutral agent names only).

const base = orchestrationSnapshot.orchestration
const at = (minutes: number) =>
  new Date(Date.UTC(2026, 9, 28, 10, 0) + minutes * 60_000).toISOString()

const step = (id: string, patch: Record<string, unknown>) => ({
  id,
  agentId: 'builder',
  instruction: `do ${id}`,
  after: [],
  replaces: null,
  status: 'succeeded',
  disposition: null,
  estimateUsd: 0.5,
  result: null,
  resultRevision: 0,
  gateId: null,
  attemptId: null,
  createdAt: at(0),
  updatedAt: at(1),
  ...patch,
})

export const agents = [
  { id: 'lead', name: 'lead', style: { color: '#3355ff', shape: 'circle-dot' } },
  { id: 'builder', name: 'builder', style: { color: '#118855', shape: 'square' } },
  { id: 'reviewer', name: 'reviewer', style: { color: '#aa3366', shape: 'diamond' } },
  { id: 'designer', name: 'designer', style: { color: '#cc7700', shape: 'triangle' } },
] as unknown as AgentSummary[]

export const fullRun = {
  ...base,
  status: 'running',
  plan: ['one', 'two', 'three', 'four'],
  leadTurnsUsed: 9,
  maxLeadTurns: 30,
  attempts: [
    {
      ...base.attempts[0]!,
      id: 'al',
      kind: 'lead',
      stepId: null,
      agentId: 'lead',
      state: 'running',
      terminatedAt: null,
    },
    {
      ...base.attempts[0]!,
      id: 'a5',
      kind: 'step',
      stepId: 's5',
      agentId: 'builder',
      state: 'running',
    },
    {
      ...base.attempts[0]!,
      id: 'ah',
      kind: 'step',
      stepId: 'h1',
      agentId: 'designer',
      state: 'running',
    },
  ],
  stepsList: [
    step('s1', { status: 'succeeded' }),
    step('s2', { status: 'succeeded' }),
    step('s3', { status: 'cancelled' }),
    step('s4', { agentId: 'reviewer', status: 'queued' }),
    step('s5', {
      status: 'admitted',
      attemptId: 'a5',
      lastActivityAt: at(-20),
    }),
    step('h1', {
      agentId: 'designer',
      role: 'helper',
      helperRole: 'audit',
      status: 'admitted',
      attemptId: 'ah',
      lastActivityAt: at(1),
    }),
    step('h2', { agentId: 'reviewer', role: 'helper', helperRole: 'grep', status: 'succeeded' }),
    step('v1', { agentId: 'designer', role: 'vote', status: 'succeeded' }),
    step('x1', { agentId: 'reviewer', role: 'advisor', status: 'succeeded' }),
  ],
  helpers: {
    agentIds: ['designer', 'reviewer'],
    maxConcurrent: 3,
    maxSteps: 20,
    used: 3,
    scan: false,
    scanFolder: null,
    splitTo: 'lead',
    votes: ['q1', 'q2', 'q3', 'q4'].map((id, index) => ({
      id,
      question: `question ${id}`,
      options: ['yes', 'no'],
      k: 3,
      status: index === 3 ? 'voting' : index === 2 ? 'split' : 'sharp',
      counts: [3, 0],
      choice: index === 2 || index === 3 ? null : 0,
      share: index === 3 ? null : index === 2 ? 0.5 : 1,
      inquiryId: null,
      createdAt: at(index),
    })),
  },
  advisor: {
    agentId: 'reviewer',
    mode: 'on_call',
    consults: [
      {
        stepId: 'x1',
        checkpoint: 'before_plan',
        reason: '',
        status: 'succeeded',
        advice: 'Split it.',
        createdAt: at(2),
      },
    ],
    onCall: [
      {
        stepId: 's5',
        agentId: 'builder',
        at: at(5),
        question: 'which file?',
        status: 'done',
        totalTokens: 12000,
      },
      {
        stepId: 's5',
        agentId: 'builder',
        at: at(8),
        question: 'retry how?',
        status: 'done',
        totalTokens: 6000,
      },
    ],
  },
  check: {
    command: 'pnpm test',
    workspace: '/work/project',
    timeoutSec: 600,
    when: 'finish',
    waivedAt: null,
    runs: [
      {
        id: 'c1',
        reason: 'lead',
        queuedAt: at(9),
        startedAt: at(9),
        endedAt: at(10),
        exitCode: 1,
        outcome: 'failed',
        output: '',
        current: true,
      },
    ],
  },
} as unknown as OrchestrationDetail

/** A plain job: no advisor, helpers or check; only the lead's steps. */
export const plainRun = {
  ...base,
  advisor: null,
  helpers: null,
  check: null,
  stepsList: base.stepsList.filter((item) => !item.role),
} as unknown as OrchestrationDetail

const event = (id: string, minutes: number, patch: Partial<OrchEvent>): OrchEvent => ({
  id,
  at: at(minutes),
  kind: 'step_state',
  stepId: null,
  attemptId: null,
  tool: null,
  verdict: null,
  code: null,
  summary: id,
  ...patch,
})

export const events: OrchEvent[] = [
  event('e-start', 0, { kind: 'run_started', summary: 'Run started' }),
  event('e-lead', 3, { kind: 'lead_wake', summary: 'assigning s5' }),
  event('e-s1', 4, {
    kind: 'step_result',
    stepId: 's1',
    verdict: 'succeeded',
    summary: 'builder finished s1',
  }),
  event('e-h1', 6, { kind: 'step_admitted', stepId: 'h1', summary: 'designer audits the diff' }),
  event('e-vote', 7, { kind: 'command', tool: 'orch.vote', summary: 'vote on the approach' }),
  event('e-check', 11, { kind: 'command', tool: 'orch.check', summary: 'run the check' }),
]
