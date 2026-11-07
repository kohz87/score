import * as contract from '../src/index.ts'
import * as f from './fixtures.ts'
import { watchMarker, watchOverviewItem, watchResponse } from './schemas-helpers.ts'

export const watchStreamCases = [
  ['WatchFrameSchema', f.watch, { ...f.watch, surface: 'desktop' }],
  ['WatchMarkerKindSchema', 'command', 'typing'],
  ['WatchMarkerSchema', watchMarker, { ...watchMarker, seq: 0 }],
  [
    'WatchResponseSchema',
    watchResponse,
    { ...watchResponse, frames: [{ ...f.watch, surface: 'desktop' }] },
  ],
  ['WatchOverviewItemSchema', watchOverviewItem, { ...watchOverviewItem, surface: 'desktop' }],
  [
    'WatchOverviewSchema',
    { items: [watchOverviewItem] },
    { items: [{ ...watchOverviewItem, live: 'yes' }] },
  ],
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
  ['BridgeIdentifierSchema', 'session-1', 'has space'],
  ['BridgeEventsRequestSchema', { events: [f.bridgeEvent] }, { events: [{ counter: 1 }] }],
  ['BridgeEventsResponseSchema', { ackedThrough: 1 }, { ackedThrough: '1' }],
  ['BridgeDecisionsRequestSchema', { wait: 25 }, { wait: '31' }],
  ['BridgeDecisionSchema', f.bridgeDecision, { ...f.bridgeDecision, requestId: null }],
  ['BridgeDecisionsResponseSchema', { items: [f.bridgeDecision] }, { items: [{}] }],
  ['BridgeDecisionAckRequestSchema', f.bridgeAck, { ...f.bridgeAck, outcome: 'denied' }],
] as const satisfies ReadonlyArray<readonly [keyof typeof contract, unknown, unknown]>
