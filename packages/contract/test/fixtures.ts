import type * as Contract from '../src/index.ts'

export const at = '2026-10-06T12:00:00.000Z'
export const later = '2026-10-06T13:00:00.000Z'

export const style = { color: '#4A2FD9', shape: 'circle-dot' } satisfies Contract.AgentStyle
export const agent = {
  id: 'lead',
  name: 'Lead',
  role: 'Leads the team',
  style,
  status: 'working',
  activity: 'Reviewing the contract',
  model: { id: 'example-model', label: 'Example model' },
  served: true,
} satisfies Contract.AgentSummary
export const routine = {
  id: 'routine-1',
  title: 'Nightly check',
  schedule: '1d',
  description: 'Runs the test suite.',
  lastRunAt: null,
  enabled: true,
} satisfies Contract.RoutineSummary
export const agentDetail = {
  ...agent,
  tagline: 'Builds what lead plans.',
  personality: { excerpt: 'Careful builder.', source: 'SOUL.md' },
  reportsTo: null,
  worksIn: null,
  rulesFile: 'AGENTS.md',
  model: {
    id: 'example-model',
    label: 'Example model',
    via: 'Hermes configuration',
    fallback: null,
  },
  skills: [{ name: 'git', enabled: true }],
  memory: [],
  tools: [{ id: 'terminal', label: 'Terminal', kind: 'builtin', enabled: true }],
  helpersMax: null,
  routines: [routine],
  channels: [],
  permissions: [{ id: 'installs', label: 'Installs', level: 'asks', inherited: true }],
} satisfies Contract.AgentDetail

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

export const room = {
  id: 'room-1',
  name: '#contract',
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder', 'reviewer', 'designer'],
  unread: 2,
  activeAgents: ['builder'],
  channels: [{ platform: 'local', label: 'Score' }],
  pinned: true,
  archived: false,
  projectId: 'project-1',
  tags: ['q4'],
  importedFrom: null,
} satisfies Contract.Room

export const roomProject = {
  id: 'project-1',
  name: 'Launch',
  color: '#4A2FD9',
} satisfies Contract.RoomProject

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

export const watch = {
  seq: 1,
  at,
  agentId: 'builder',
  runId: 'run-1',
  surface: 'terminal',
  terminal: { cwd: '/workspace/score', command: 'pnpm test', output: 'Passed', status: 'ok' },
  caption: 'Checked the tests',
} satisfies Contract.WatchFrame

export const delta = {
  messageId: 'message-1',
  roomId: 'room-1',
  append: 'Done',
} satisfies Contract.MessageDelta
export const completed = {
  messageId: 'message-1',
  roomId: 'room-1',
} satisfies Contract.MessageCompleted
export const knowledgeChanged = {
  path: 'projects/pager.md',
  kind: 'written' as const,
  to: null,
  by: { agentId: 'builder' },
}
export const roomVersion = {
  id: 'version-1',
  roomId: 'room-1',
  anchorId: 'message-1',
  anchorCreatedAt: at,
  mode: 'edit' as const,
  replacedBy: null,
  number: 1,
  count: 2,
  hiddenCount: 3,
  rewound: [{ agentId: 'builder', turnsUndone: 2 }],
  skipped: [{ agentId: 'reviewer', reason: 'compressed' as const }],
  createdAt: at,
} satisfies Contract.RoomVersion
export const deleted = {
  messageId: 'message-1',
  roomId: 'room-1',
} satisfies Contract.MessageDeleted
export const updated = {
  messageId: 'message-1',
  roomId: 'room-1',
  editedBy: 'message-2',
} satisfies Contract.MessageUpdated
export const typing = {
  roomId: 'room-1',
  agentId: 'lead',
  text: 'is reviewing',
} satisfies Contract.Typing
export const taskActivity = { taskId: 'task-1', item: activity } satisfies Contract.TaskActivityData
export const laneUpserted = {
  briefId: 'brief-1',
  agentId: 'builder',
  block: lane,
} satisfies Contract.LaneUpserted
export const attemptUpdated = attempt satisfies Contract.AttemptSummary
export const handoffCreated = {
  briefId: 'brief-1',
  handoff,
} satisfies Contract.HandoffCreated
export const brief = {
  id: 'brief-1',
  title: 'Add pagination',
  roomId: 'room-1',
  startedAt: at,
  startedBy: 'you',
  status: 'running',
} satisfies Contract.BriefSummary
export const gap = {
  source: 'bridge',
  runId: 'run-1',
  from: at,
  to: later,
  reason: 'Producer disconnected',
} satisfies Contract.GapRecorded
export const memory = {
  agentIds: ['lead', 'designer'],
  text: 'Use neutral agent names',
  source: { kind: 'room', roomId: 'room-1' },
} satisfies Contract.MemorySaved

export const event = {
  seq: 1,
  ts: at,
  type: 'agent.updated',
  data: agent,
} satisfies Contract.StreamEvent
export const hello = {
  type: 'stream.hello',
  data: { epoch: 'epoch-1', headSeq: 0, mode: 'fake', system },
} satisfies Contract.StreamHello
export const reset = {
  type: 'stream.reset',
  data: { reason: 'pruned' },
} satisfies Contract.StreamReset

export const bridgeHelloRequest = {
  profile: 'builder',
  pid: 123,
  incarnation: 'incarnation-1',
  kanbanTaskId: 'task-1',
  isolation: 'in_process',
  pluginVersion: '0.1.0',
  hermes: { version: '0.21.0', codeSha: 'fixture-sha' },
  privateApis: { resolve_gateway_approval: true },
} satisfies Contract.BridgeHelloRequest
export const bridgeHelloResponse = {
  producerToken: 'fixture-token',
  expiresAt: later,
  enabled: { gatewayApprovals: true, kanbanGrants: false, watch: true },
} satisfies Contract.BridgeHelloResponse
export const bridgeEvent = {
  counter: 1,
  hook: 'pre_tool_call',
  at,
  sessionKey: 'session-key-1',
  sessionId: 'session-1',
  toolCallId: 'tool-call-1',
  payload: { tool: 'terminal', args: { command: 'pnpm test' }, redacted: true },
} satisfies Contract.BridgeEvent
export const bridgeDecision = {
  deliveryId: 'delivery-1',
  leaseId: 'lease-1',
  leaseUntil: later,
  sessionKey: 'session-key-1',
  requestId: 'request-1',
  choice: 'once',
  reason: null,
} satisfies Contract.BridgeDecision
export const bridgeAck = {
  leaseId: 'lease-1',
  outcome: 'failed',
  resolved: 0,
  error: 'Request no longer pending',
} satisfies Contract.BridgeDecisionAckRequest
