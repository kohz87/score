import type * as Contract from '../src/index.ts'
import { agent } from './fixtures-agents.ts'
import { at, later } from './fixtures-common.ts'
import { activity, attempt, handoff, lane, system } from './fixtures-now-tasks.ts'

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
export const progressed = {
  messageId: 'message-1',
  roomId: 'room-1',
  at,
} satisfies Contract.MessageProgressed
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
export const lookChanged = {
  activeTheme: 'paper',
  mode: 'dark',
  resetGeneration: 2,
} satisfies Contract.LookChanged

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
