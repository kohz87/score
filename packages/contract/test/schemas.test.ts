import { describe, expect, test } from 'vitest'
import * as contract from '../src/index.ts'
import * as f from './fixtures.ts'

const cases = [
  ['AgentIdSchema', 'lead', ''],
  ['ShapeSchema', 'circle-dot', 'oval'],
  ['AgentStyleSchema', f.style, { ...f.style, color: '#abc' }],
  ['AgentStatusSchema', 'working', 'busy'],
  ['AgentSummarySchema', f.agent, { ...f.agent, id: '' }],
  ['RefSchema', f.refs[0], { kind: 'room', roomId: '' }],
  ['ApprovalChoiceSchema', 'once', 'forever'],
  ['ApprovalSchema', f.approval, { ...f.approval, createdAt: 'yesterday' }],
  ['TaskColumnSchema', 'planned', 'queued'],
  ['TaskSummarySchema', f.task, { ...f.task, progress: 1.1 }],
  ['TaskStepSchema', f.step, { ...f.step, done: 'yes' }],
  ['TaskActivitySchema', f.activity, { ...f.activity, agentId: '' }],
  ['TaskDetailSchema', f.detail, { ...f.detail, dependsOn: [''] }],
  ['RoomSchema', f.room, { ...f.room, members: [''] }],
  ['LaneBlockSchema', f.lane, { ...f.lane, end: 'later' }],
  ['MessagePartSchema', f.parts[0], { kind: 'approval', approvalId: '' }],
  ['MessageSchema', f.message, { ...f.message, author: { kind: 'agent' } }],
  ['RunSummarySchema', f.run, { ...f.run, status: 'done' }],
  ['HandoffSchema', f.handoff, { ...f.handoff, to: { agentId: 'reviewer', blockId: '' } }],
  ['SystemStatusSchema', f.system, { ...f.system, agentIsolation: 'host' }],
  ['LogLineSchema', f.log, { ...f.log, kind: 'debug' }],
  ['WatchFrameSchema', f.watch, { ...f.watch, surface: 'desktop' }],
  ['MessageDeltaSchema', f.delta, { ...f.delta, append: null }],
  ['MessageCompletedSchema', f.completed, { ...f.completed, roomId: '' }],
  ['TypingSchema', f.typing, { ...f.typing, text: 1 }],
  ['TaskActivityDataSchema', f.taskActivity, { ...f.taskActivity, item: {} }],
  ['LaneUpsertedSchema', f.laneUpserted, { ...f.laneUpserted, block: {} }],
  ['HandoffCreatedSchema', f.handoffCreated, { ...f.handoffCreated, handoff: {} }],
  ['GapRecordedSchema', f.gap, { ...f.gap, from: 'yesterday' }],
  ['MemorySavedSchema', f.memory, { ...f.memory, source: { kind: 'unknown' } }],
  ['StreamEnvelopeSchema', f.event, { ...f.event, data: [] }],
  ['StreamEventSchema', f.event, { ...f.event, seq: 0 }],
  ['StreamHelloSchema', f.hello, { ...f.hello, seq: 1 }],
  ['StreamResetSchema', f.reset, { type: 'stream.reset', data: { reason: 'unknown' } }],
  ['StreamControlFrameSchema', f.hello, f.event],
  [
    'ParsedStreamFrameSchema',
    { kind: 'event', event: f.event },
    { kind: 'event', event: { ...f.event, seq: 0 } },
  ],
  [
    'BridgeHelloRequestSchema',
    f.bridgeHelloRequest,
    { ...f.bridgeHelloRequest, privateApis: { unresolved: 'yes' } },
  ],
  [
    'BridgeHelloResponseSchema',
    f.bridgeHelloResponse,
    { ...f.bridgeHelloResponse, expiresAt: 'later' },
  ],
  ['BridgeEventSchema', f.bridgeEvent, { ...f.bridgeEvent, payload: [] }],
  ['BridgeEventsRequestSchema', { events: [f.bridgeEvent] }, { events: [{ counter: 1 }] }],
  ['BridgeEventsResponseSchema', { ackedThrough: 1 }, { ackedThrough: '1' }],
  ['BridgeDecisionsRequestSchema', { wait: 25 }, { wait: '31' }],
  ['BridgeDecisionSchema', f.bridgeDecision, { ...f.bridgeDecision, requestId: null }],
  ['BridgeDecisionsResponseSchema', { items: [f.bridgeDecision] }, { items: [{}] }],
  ['BridgeDecisionAckRequestSchema', f.bridgeAck, { ...f.bridgeAck, outcome: 'denied' }],
  ['BridgeGrantRedeemRequestSchema', f.redeem, { ...f.redeem, taskRunId: '1' }],
  ['BridgeGrantRedeemResponseSchema', f.grant, { ...f.grant, grantId: '' }],
  ['BridgeGrantConsumeRequestSchema', f.consume, { ...f.consume, toolCallId: '' }],
] as const satisfies ReadonlyArray<readonly [keyof typeof contract, unknown, unknown]>

test('every exported schema has valid and invalid fixtures', () => {
  const exported = Object.keys(contract).filter((name) => name.endsWith('Schema'))
  expect(cases.map(([name]) => name).sort()).toEqual(exported.sort())
})

describe.each(cases)('%s', (name, valid, invalid) => {
  const schema = contract[name]
  test('round-trips a valid JSON fixture', () => {
    expect(schema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })
  test('rejects an invalid fixture', () => {
    expect(schema.safeParse(invalid).success).toBe(false)
  })
})
