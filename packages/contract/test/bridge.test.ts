import { describe, expect, test } from 'vitest'
import {
  BridgeDecisionAckRequestSchema,
  BridgeDecisionSchema,
  BridgeDecisionsRequestSchema,
  BridgeDecisionsResponseSchema,
  BridgeEventSchema,
  BridgeEventsRequestSchema,
  BridgeEventsResponseSchema,
  BridgeGrantConsumeRequestSchema,
  BridgeGrantRedeemRequestSchema,
  BridgeHelloRequestSchema,
  BridgeHelloResponseSchema,
} from '../src/index.ts'
import * as f from './fixtures.ts'

test('accepts a host-isolated producer without a Kanban task', () => {
  const request = { ...f.bridgeHelloRequest, isolation: 'host', kanbanTaskId: null }
  expect(BridgeHelloRequestSchema.parse(request)).toEqual(request)
})

test('accepts absent session and tool identities on a bridge event', () => {
  const event = { ...f.bridgeEvent, sessionKey: null, sessionId: null, toolCallId: null }
  expect(BridgeEventSchema.parse(event)).toEqual(event)
})

test.each([[], null, 'text', 1])('rejects non-object bridge payload %j', (payload) => {
  expect(BridgeEventSchema.safeParse({ ...f.bridgeEvent, payload }).success).toBe(false)
})

test('retains arbitrary nested, redacted bridge payload fields', () => {
  const payload = { arbitrary: { values: [1, null, true, 'REDACTED'] }, extra: 'field' }
  const event = { ...f.bridgeEvent, payload }
  expect(BridgeEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event)
})

test('accepts empty batches and an empty decisions response', () => {
  expect(BridgeEventsRequestSchema.parse({ events: [] })).toEqual({ events: [] })
  expect(BridgeDecisionsResponseSchema.parse({ items: [] })).toEqual({ items: [] })
  expect(BridgeDecisionsRequestSchema.parse({})).toEqual({ wait: 25 })
})

test.each([0, 25, 30, '0', '25', '30'])('parses wait=%s as integer seconds', (wait) => {
  expect(BridgeDecisionsRequestSchema.parse({ wait })).toEqual({ wait: Number(wait) })
})

test('defaults an undefined wait to 25 seconds', () => {
  expect(BridgeDecisionsRequestSchema.parse({ wait: undefined })).toEqual({ wait: 25 })
})

test.each([-1, 31, 0.5, '-1', '31', '0.5', 'invalid', Infinity])(
  'rejects invalid wait=%s',
  (wait) => {
    expect(BridgeDecisionsRequestSchema.safeParse({ wait }).success).toBe(false)
  },
)

const positiveIntegerCases = [
  [
    'BridgeHelloRequest.pid',
    BridgeHelloRequestSchema,
    (pid: number) => ({ ...f.bridgeHelloRequest, pid }),
  ],
  ['BridgeEvent.counter', BridgeEventSchema, (counter: number) => ({ ...f.bridgeEvent, counter })],
  [
    'BridgeGrantRedeemRequest.taskRunId',
    BridgeGrantRedeemRequestSchema,
    (taskRunId: number) => ({ ...f.redeem, taskRunId }),
  ],
] as const

describe.each(positiveIntegerCases)('%s', (_name, schema, fixture) => {
  test('accepts a positive integer', () => {
    expect(schema.parse(fixture(1))).toEqual(fixture(1))
  })
  test.each([-1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid integer %s', (value) => {
    expect(schema.safeParse(fixture(value)).success).toBe(false)
  })
})

const nonnegativeIntegerCases = [
  [
    'BridgeEventsResponse.ackedThrough',
    BridgeEventsResponseSchema,
    (ackedThrough: number) => ({ ackedThrough }),
  ],
  [
    'BridgeDecisionAckRequest.resolved',
    BridgeDecisionAckRequestSchema,
    (resolved: number) => ({ ...f.bridgeAck, resolved }),
  ],
] as const

describe.each(nonnegativeIntegerCases)('%s', (_name, schema, fixture) => {
  test.each([0, 1])('accepts non-negative integer %s', (value) => {
    expect(schema.parse(fixture(value))).toEqual(fixture(value))
  })
  test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid integer %s', (value) => {
    expect(schema.safeParse(fixture(value)).success).toBe(false)
  })
})

test('rejects an empty producer token', () => {
  expect(
    BridgeHelloResponseSchema.safeParse({ ...f.bridgeHelloResponse, producerToken: '' }).success,
  ).toBe(false)
})

test.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)])(
  'rejects invalid SHA-256 digest %s',
  (commandDigest) => {
    expect(BridgeGrantRedeemRequestSchema.safeParse({ ...f.redeem, commandDigest }).success).toBe(
      false,
    )
  },
)

test.each(['once', 'session', 'always', 'deny'])('accepts the %s decision choice', (choice) => {
  const decision = { ...f.bridgeDecision, choice, reason: 'Human decision' }
  expect(BridgeDecisionSchema.parse(decision)).toEqual(decision)
})

test.each(['applied', 'not_pending', 'failed'])('accepts the %s delivery ack', (outcome) => {
  const request = { outcome, resolved: 0 }
  expect(BridgeDecisionAckRequestSchema.parse(request)).toEqual(request)
})

test.each(['executed', 'blocked', 'revoked'])('accepts the %s grant outcome', (outcome) => {
  const request = { ...f.consume, outcome }
  expect(BridgeGrantConsumeRequestSchema.parse(request)).toEqual(request)
})

test('rejects deliveries without an exact request or session', () => {
  expect(BridgeDecisionSchema.safeParse({ ...f.bridgeDecision, requestId: '' }).success).toBe(false)
  expect(BridgeDecisionSchema.safeParse({ ...f.bridgeDecision, sessionKey: '' }).success).toBe(
    false,
  )
})
