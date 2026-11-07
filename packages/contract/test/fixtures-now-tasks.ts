import type * as Contract from '../src/index.ts'
import { at, later } from './fixtures-common.ts'

export const refs = [
  { kind: 'room', roomId: 'room-1' },
  { kind: 'task', taskId: 'task-1' },
  { kind: 'run', runId: 'run-1' },
  { kind: 'brief', briefId: 'brief-1' },
] satisfies Contract.Ref[]

export const approval = {
  id: 'approval-1',
  origin: 'kanban',
  phase: 'decided',
  status: 'approved',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'Can I run this command?',
  command: 'pnpm test',
  cwd: '/workspace/score',
  description: 'Command requires a decision',
  choices: ['once', 'always', 'deny'],
  createdAt: at,
  expiresAt: later,
  decision: { choice: 'once', by: 'you', at },
  delivery: 'intent',
  blocking: 'Builder is waiting',
  refs,
} satisfies Contract.Approval

export const task = {
  id: 'task-1',
  key: 'T-114',
  title: 'Build the contract',
  column: 'working',
  hermesStatus: 'running',
  assignee: 'builder',
  reviewer: 'reviewer',
  roomId: 'room-1',
  badge: { kind: 'starts_after', label: 'After review' },
  progress: 0.5,
  elapsedSec: 30,
  note: 'In progress',
  updatedAt: at,
} satisfies Contract.TaskSummary

export const step = {
  id: 'step-1',
  text: 'Validate the schemas',
  done: false,
} satisfies Contract.TaskStep
export const activity = {
  at,
  agentId: 'reviewer',
  text: 'Review started',
} satisfies Contract.TaskActivity
export const detail = {
  ...task,
  body: 'Implement shared schemas',
  createdBy: 'you',
  steps: [step],
  activity: [activity],
  pendingApproval: approval,
  dependsOn: ['task-0'],
  blocks: ['task-2'],
  runIds: ['run-1'],
} satisfies Contract.TaskDetail

export const lane = {
  id: 'block-1',
  label: 'Build schemas',
  state: 'working',
  start: at,
  end: later,
  taskId: 'task-1',
  runId: 'run-1',
  kind: 'task',
} satisfies Contract.LaneBlock

export const parts = [
  { kind: 'text', text: 'Starting the contract' },
  { kind: 'plan', lanes: [{ agentId: 'builder', blocks: [lane] }], briefId: 'brief-1' },
  { kind: 'tools', summary: 'Ran tests', runId: 'run-1' },
  { kind: 'tool', tool: 'terminal', args: 'pnpm test', result: '12 passed', status: 'ok' },
  { kind: 'thinking', text: 'The tests come first.' },
  { kind: 'file', path: 'src/types.ts', added: 20, removed: 1 },
  { kind: 'approval', approvalId: 'approval-1' },
  { kind: 'review', verdict: 'approved', taskId: 'task-1' },
] satisfies Contract.MessagePart[]

export const message = {
  id: 'message-1',
  roomId: 'room-1',
  author: { kind: 'agent', agentId: 'lead' },
  to: ['builder'],
  parts,
  createdAt: at,
  streaming: false,
  progressAt: later,
  refs,
} satisfies Contract.Message

export const run = {
  id: 'run-1',
  agentId: 'builder',
  origin: 'score',
  status: 'completed',
  startedAt: at,
  endedAt: later,
  model: 'example-model',
  toolsUsed: ['terminal'],
  tokens: { input: 100, output: 50 },
  costUsd: 0.01,
  refs,
  gaps: [{ from: at, to: later, reason: 'Producer disconnected' }],
} satisfies Contract.RunSummary

export const taskRef = {
  taskId: 'task-1',
  historyId: 'kh_1',
  current: true,
} satisfies Contract.TaskRef
export const attempt = {
  id: 'kr_0f8a4c2e-6a35-4b8b-9a3c-1d2e3f4a5b6c',
  kind: 'kanban',
  agentId: 'builder',
  role: 'implementer',
  status: 'completed',
  closureReason: 'completed',
  startedAt: at,
  endedAt: later,
  observationEndedAt: null,
  evidence: 'proven',
  taskId: 'task-1',
  task: taskRef,
  order: [at, 41],
  refusedUpdates: 0,
  tools: null,
  session: null,
  model: null,
} satisfies Contract.AttemptSummary
/** An attempt whose claiming profile Score cannot know, from an earlier copy of the board, still unfinished. */
export const unattributedAttempt = {
  ...attempt,
  id: 'kr_9b1d0e7a-1c52-4e7e-8d0f-5a6b7c8d9e0f',
  agentId: null,
  role: null,
  status: 'running',
  closureReason: null,
  endedAt: null,
  observationEndedAt: later,
  evidence: 'partial',
  task: { ...taskRef, historyId: 'kh_0', current: false },
  order: [at, 42],
} satisfies Contract.AttemptSummary
export const attemptDetail = {
  ...attempt,
  taskSnapshot: { title: 'Build the contract', status: 'done', assignee: 'builder' },
} satisfies Contract.AttemptDetail
export const attemptLane = {
  id: `attempt:${attempt.id}`,
  label: 'Build the contract',
  state: 'done',
  start: at,
  end: later,
  taskId: 'task-1',
  runId: null,
  kind: 'task',
  attemptId: attempt.id,
  observationEndedAt: null,
  provenance: 'proven',
  order: [at, 41],
} satisfies Contract.LaneBlock
export const unattributedHandoff = {
  id: 'handoff-2',
  from: { agentId: null, blockId: `attempt:${unattributedAttempt.id}` },
  to: { agentId: 'reviewer', blockId: 'block-2' },
  kind: 'handoff',
  at,
} satisfies Contract.Handoff

export const handoff = {
  id: 'handoff-1',
  from: { agentId: 'builder', blockId: 'block-1' },
  to: { agentId: 'reviewer', blockId: 'block-2' },
  kind: 'review',
  at,
} satisfies Contract.Handoff

export const system = {
  mode: 'fake',
  hermes: {
    version: '0.21.0',
    reachable: true,
    apiServer: true,
    capabilities: ['runs'],
    servedProfiles: ['lead', 'builder', 'reviewer', 'designer'],
  },
  bridge: { producers: 1, lastSeenAt: at, isolation: 'in_process' },
  compatibility: { fingerprint: 'fixture', tested: true, disabled: [] },
  agentIsolation: 'same_user',
  degraded: [],
} satisfies Contract.SystemStatus

export const log = {
  id: 'log-1',
  at,
  agentId: 'builder',
  kind: 'tool',
  text: 'Ran the tests',
} satisfies Contract.LogLine
