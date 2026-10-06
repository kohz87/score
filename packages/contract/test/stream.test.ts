import { describe, expect, expectTypeOf, test } from 'vitest'
import {
  ParsedStreamFrameSchema,
  StreamControlFrameSchema,
  StreamEventSchema,
  StreamHelloSchema,
  StreamResetSchema,
  parseStreamFrame,
} from '../src/index.ts'
import type { AgentSummary, StreamEvent } from '../src/index.ts'
import * as f from './fixtures.ts'

const eventData = {
  'system.status': f.system,
  'agent.updated': f.agent,
  'message.created': f.message,
  'message.delta': f.delta,
  'message.completed': f.completed,
  typing: f.typing,
  'approval.requested': f.approval,
  'approval.updated': f.approval,
  'task.upserted': f.task,
  'task.activity': f.taskActivity,
  'lane.upserted': f.laneUpserted,
  'handoff.created': f.handoffCreated,
  'run.updated': f.run,
  'gap.recorded': f.gap,
  'log.line': f.log,
  'watch.frame': f.watch,
  'memory.saved': f.memory,
} satisfies { [Type in StreamEvent['type']]: Extract<StreamEvent, { type: Type }>['data'] }

describe.each(Object.entries(eventData))('%s', (type, data) => {
  const event = { seq: 7, ts: f.at, type, data }
  test('round-trips and parses as a durable event', () => {
    const json = JSON.parse(JSON.stringify(event))
    expect(StreamEventSchema.parse(json)).toEqual(event)
    expect(parseStreamFrame(json)).toEqual({ kind: 'event', event })
    expect(parseStreamFrame(JSON.stringify(event))).toEqual({ kind: 'event', event })
  })
  test('rejects invalid data for a known type', () => {
    expect(() => parseStreamFrame({ ...event, data: {} })).toThrow()
  })
  test('rejects a zero sequence', () => {
    expect(() => parseStreamFrame({ ...event, seq: 0 })).toThrow()
  })
})

test('event types narrow their payload types', () => {
  const event = StreamEventSchema.parse(f.event)
  if (event.type === 'agent.updated') {
    expectTypeOf(event.data).toEqualTypeOf<AgentSummary>()
  }
})

test.each([f.hello, f.reset])('parses $type as a control frame', (frame) => {
  expect(StreamControlFrameSchema.parse(frame)).toEqual(frame)
  expect(parseStreamFrame(frame)).toEqual({ kind: 'control', frame })
  expect(parseStreamFrame(JSON.stringify(frame))).toEqual({ kind: 'control', frame })
  expect(StreamEventSchema.safeParse(frame).success).toBe(false)
  expect(StreamEventSchema.safeParse({ ...frame, seq: 1, ts: f.at }).success).toBe(false)
  expect(StreamControlFrameSchema.safeParse({ ...frame, seq: 1 }).success).toBe(false)
  expect(() => parseStreamFrame({ ...frame, seq: 1 })).toThrow()
})

test.each([f.hello, f.reset])('accepts future fields on $type', (frame) => {
  const futureFrame = { ...frame, future: true, data: { ...frame.data, future: 'new field' } }
  expect(StreamControlFrameSchema.parse(futureFrame)).toEqual(frame)
  expect(parseStreamFrame(futureFrame)).toEqual({ kind: 'control', frame })
})

test.each(['pruned', 'epoch', 'future_cursor'])('accepts reset reason %s', (reason) => {
  const frame = { type: 'stream.reset', data: { reason } }
  expect(StreamResetSchema.parse(frame)).toEqual(frame)
})

test('hello accepts an empty log and rejects invalid head sequences', () => {
  expect(StreamHelloSchema.parse(f.hello).data.headSeq).toBe(0)
  for (const headSeq of [-1, 0.5]) {
    expect(
      StreamHelloSchema.safeParse({ ...f.hello, data: { ...f.hello.data, headSeq } }).success,
    ).toBe(false)
  }
})

test.each([-1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid seq %s', (seq) => {
  expect(StreamEventSchema.safeParse({ ...f.event, seq }).success).toBe(false)
})

test('ignores unknown types without validating a future payload format', () => {
  for (const value of [
    { ...f.event, type: 'future.created' },
    { type: 'future.created', data: ['new format'] },
    { type: 'future.created' },
  ]) {
    expect(parseStreamFrame(value)).toEqual({ kind: 'unknown', type: 'future.created' })
    expect(parseStreamFrame(JSON.stringify(value))).toEqual({
      kind: 'unknown',
      type: 'future.created',
    })
  }
})

test.each([null, [], {}, { type: 3 }, 'not JSON'])('rejects malformed input %j', (value) => {
  expect(() => parseStreamFrame(value)).toThrow()
})

test('rejects invalid known control payloads', () => {
  expect(() => parseStreamFrame({ type: 'stream.hello', data: {} })).toThrow()
  expect(() => parseStreamFrame({ type: 'stream.reset', data: { reason: 'other' } })).toThrow()
})

test.each([
  { kind: 'event', event: f.event },
  { kind: 'control', frame: f.hello },
  { kind: 'control', frame: f.reset },
  { kind: 'unknown', type: 'future.created' },
])('round-trips the $kind parser result', (result) => {
  expect(ParsedStreamFrameSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result)
})
