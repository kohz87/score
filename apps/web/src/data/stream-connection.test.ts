import { expect, test, vi } from 'vitest'
import { createStreamClient } from './stream.ts'
import { clients, delta, hello, MockEventSource, setup, system } from './stream-helpers.ts'

test('stream reconnects with its cursor, doubles backoff and resets backoff after hello', () => {
  vi.useFakeTimers()
  const { client, source } = setup()
  const statuses: string[] = []
  client.status.subscribe(() => statuses.push(client.status.getSnapshot()))
  expect(source.url).toBe('/api/stream')
  hello(source, 'epoch with spaces')
  delta(source, 7)
  source.error()
  expect(source.closed).toBe(true)
  vi.advanceTimersByTime(499)
  expect(MockEventSource.instances).toHaveLength(1)
  vi.advanceTimersByTime(1)
  const second = MockEventSource.instances[1]!
  expect(second.url).toBe('/api/stream?since=7&epoch=epoch+with+spaces')
  second.error()
  vi.advanceTimersByTime(999)
  expect(MockEventSource.instances).toHaveLength(2)
  vi.advanceTimersByTime(1)
  const third = MockEventSource.instances[2]!
  hello(third, 'epoch with spaces')
  third.error()
  vi.advanceTimersByTime(500)
  expect(MockEventSource.instances).toHaveLength(4)
  expect(statuses).toEqual(['open', 'reconnecting', 'reconnecting', 'open', 'reconnecting'])
  client.close()
  MockEventSource.instances[3]!.error()
  vi.runAllTimers()
  expect(MockEventSource.instances).toHaveLength(4)
})

test('stream fresh reconnects omit cursors, cap the backoff and jitter it', () => {
  vi.useFakeTimers()
  const client = createStreamClient({ EventSourceImpl: MockEventSource, random: () => 1 })
  clients.push(client)
  for (const delay of [600, 1200, 2400, 4800, 9600, 12000, 12000]) {
    const count = MockEventSource.instances.length
    MockEventSource.instances.at(-1)!.error()
    vi.advanceTimersByTime(delay - 1)
    expect(MockEventSource.instances).toHaveLength(count)
    vi.advanceTimersByTime(1)
    expect(MockEventSource.instances.at(-1)!.url).toBe('/api/stream')
  }
})

test('stream ignores unknown types with one debug per type and skips malformed known frames', () => {
  const { client, source } = setup()
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const listener = vi.fn()
  client.subscribe(listener)
  source.frame({ type: 'future.event' })
  source.frame({ type: 'future.event' })
  source.frame({ type: 'another.event' })
  source.frame({ type: 'message.delta', data: {} }, 'message.delta')
  source.dispatchEvent(new MessageEvent('message', { data: 'not JSON' }))
  source.frame(
    {
      seq: 3,
      type: 'message.delta',
      ts: '2026-01-01T00:00:00.000Z',
      data: { messageId: 'm', roomId: 'r', append: '' },
    },
    'message.delta',
    '4',
  )
  expect(debug).toHaveBeenCalledTimes(2)
  expect(error).toHaveBeenCalledTimes(3)
  expect(listener).not.toHaveBeenCalled()
  delta(source, 5)
  expect(listener).toHaveBeenCalledTimes(1)
})

test('stream unknown durable envelopes advance the resume cursor without notifying queries', () => {
  vi.useFakeTimers()
  const { source, client } = setup()
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  const listener = vi.fn()
  client.subscribe(listener)
  hello(source)
  source.frame(
    { seq: 9, ts: '2026-01-01T00:00:00.000Z', type: 'future.event', data: {} },
    'message',
    '9',
  )
  source.error()
  vi.advanceTimersByTime(500)
  expect(MockEventSource.instances.at(-1)!.url).toBe('/api/stream?since=9&epoch=epoch-one')
  expect(listener).not.toHaveBeenCalled()
})

test('hello establishes a reconnect cursor before the first durable event', () => {
  vi.useFakeTimers()
  const { source } = setup()
  source.frame(
    { type: 'stream.hello', data: { epoch: 'e', headSeq: 42, mode: 'fake', system } },
    'stream.hello',
  )
  source.error()
  vi.advanceTimersByTime(500)
  expect(MockEventSource.instances.at(-1)!.url).toBe('/api/stream?since=42&epoch=e')
})

test.each([7, 500])(
  'reset rebases stale/future cursor %s to the connection head; valid replay keeps its cursor',
  (cursor) => {
    vi.useFakeTimers()
    const { source } = setup()
    hello(source)
    delta(source, cursor)
    source.error()
    vi.advanceTimersByTime(500)
    const replay = MockEventSource.instances.at(-1)!
    replay.frame(
      { type: 'stream.hello', data: { epoch: 'epoch-one', headSeq: 50, mode: 'fake', system } },
      'stream.hello',
    )
    replay.error()
    vi.advanceTimersByTime(500)
    expect(MockEventSource.instances.at(-1)!.url).toBe(
      `/api/stream?since=${cursor}&epoch=epoch-one`,
    )
    const reset = MockEventSource.instances.at(-1)!
    reset.frame(
      { type: 'stream.hello', data: { epoch: 'epoch-one', headSeq: 60, mode: 'fake', system } },
      'stream.hello',
    )
    reset.frame(
      { type: 'stream.reset', data: { reason: cursor > 60 ? 'future_cursor' : 'pruned' } },
      'stream.reset',
    )
    reset.error()
    vi.advanceTimersByTime(500)
    const next = MockEventSource.instances.at(-1)!
    expect(next.url).toBe('/api/stream?since=60&epoch=epoch-one')
    next.frame(
      { type: 'stream.hello', data: { epoch: 'epoch-two', headSeq: 2, mode: 'fake', system } },
      'stream.hello',
    )
    next.error()
    vi.advanceTimersByTime(500)
    expect(MockEventSource.instances.at(-1)!.url).toBe('/api/stream?since=2&epoch=epoch-two')
  },
)
