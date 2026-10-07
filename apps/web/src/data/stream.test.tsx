import { StrictMode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { StreamEvent, SystemStatus } from '@score/contract'
import { createStreamClient, type StreamClient } from './stream.ts'
import {
  createStreamQueryRegistry,
  defineStreamQuery,
  type StreamQueryRegistry,
  type StreamSnapshot,
} from './resync.ts'
import { createQueryClient, StreamContext, useStreamQuery } from './query-client.ts'

class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = []
  closed = false
  constructor(readonly url: string) {
    super()
    MockEventSource.instances.push(this)
  }
  close() {
    this.closed = true
  }
  frame(value: unknown, type = 'message', id = '') {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value), lastEventId: id }))
  }
  error() {
    this.dispatchEvent(new Event('error'))
  }
}
const system: SystemStatus = {
  mode: 'fake',
  hermes: { version: null, reachable: true, apiServer: true, capabilities: [], servedProfiles: [] },
  bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
  compatibility: { fingerprint: 'fake', tested: true, disabled: [] },
  agentIsolation: 'same_user',
  degraded: [],
}
function hello(source: MockEventSource, epoch = 'epoch-one') {
  source.frame(
    { type: 'stream.hello', data: { epoch, headSeq: 0, mode: 'fake', system } },
    'stream.hello',
  )
}
function delta(source: MockEventSource, seq: number, append = '!') {
  source.frame(
    {
      seq,
      ts: '2026-01-01T00:00:00.000Z',
      type: 'message.delta',
      data: { messageId: 'message', roomId: 'room', append },
    },
    'message.delta',
    String(seq),
  )
}
const clients: StreamClient[] = []
const registries: StreamQueryRegistry[] = []
const queryClients: ReturnType<typeof createQueryClient>[] = []
function setup() {
  const client = createStreamClient({ EventSourceImpl: MockEventSource, random: () => 0.5 })
  const queryClient = createQueryClient()
  const queries = createStreamQueryRegistry(queryClient, client)
  clients.push(client)
  registries.push(queries)
  queryClients.push(queryClient)
  return { client, queryClient, queries, source: MockEventSource.instances.at(-1)! }
}
function definition(key = 'text') {
  const requests: ReturnType<typeof Promise.withResolvers<StreamSnapshot<string>>>[] = []
  const fetch = vi.fn(() => {
    const request = Promise.withResolvers<StreamSnapshot<string>>()
    requests.push(request)
    return request.promise
  })
  const reduce = vi.fn((data: string, event: StreamEvent) =>
    event.type === 'message.delta' ? data + event.data.append : data,
  )
  return {
    def: defineStreamQuery({ key: [key], fetch, types: ['message.delta'], reduce }),
    requests,
    fetch,
    reduce,
  }
}
async function resolve(
  request: ReturnType<typeof Promise.withResolvers<StreamSnapshot<string>>>,
  data: string,
  asOfSeq: number,
) {
  request.resolve({ data, asOfSeq })
  await vi.waitFor(() => expect(queryClients.at(-1)!.isFetching()).toBe(0))
}
beforeEach(() => {
  MockEventSource.instances = []
})
afterEach(() => {
  cleanup()
  registries.splice(0).forEach((registry) => registry.dispose())
  clients.splice(0).forEach((client) => client.close())
  queryClients.splice(0).forEach((client) => client.clear())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('stream buffers refetch deltas, orders them and applies only those after the snapshot once', async () => {
  const { queries, queryClient, source } = setup()
  const { def, requests, reduce } = definition()
  const handle = queries.register(def)
  const off = handle.subscribe(() => {})
  await resolve(requests[0]!, 'old', 1)
  const refetch = handle.refetch()
  delta(source, 5, 'e')
  delta(source, 3, 'c')
  delta(source, 4, 'd')
  delta(source, 5, 'e')
  requests[1]!.resolve({ data: 'abc', asOfSeq: 3 })
  await refetch
  expect(handle.getSnapshot()).toMatchObject({ data: 'abcde', asOfSeq: 5, status: 'success' })
  expect(queryClient.getQueryData(def.key)).toEqual({ data: 'abcde', asOfSeq: 5 })
  expect(reduce).toHaveBeenCalledTimes(2)
  delta(source, 5)
  delta(source, 2)
  expect(reduce).toHaveBeenCalledTimes(2)
  delta(source, 8)
  expect(handle.getSnapshot().data).toBe('abcde!')
  off()
})

test('stream ignores a stale snapshot resolving last and retains its buffered events for the newer fetch', async () => {
  const { queries, source } = setup()
  const { def, requests } = definition()
  const handle = queries.register(def)
  handle.subscribe(() => {})
  delta(source, 4)
  const latest = handle.refetch()
  requests[1]!.resolve({ data: 'new', asOfSeq: 3 })
  await latest
  expect(handle.getSnapshot().data).toBe('new!')
  await resolve(requests[0]!, 'stale', 1)
  expect(handle.getSnapshot()).toMatchObject({ data: 'new!', asOfSeq: 4 })
})

test('stream superseded fetch resolving first leaves deltas buffered for its successor', async () => {
  const { queries, source } = setup()
  const { def, requests } = definition()
  const handle = queries.register(def)
  handle.subscribe(() => {})
  delta(source, 7)
  const latest = handle.refetch()
  requests[0]!.resolve({ data: 'stale', asOfSeq: 0 })
  await vi.waitFor(() => expect(queryClients.at(-1)!.isFetching()).toBe(1))
  expect(handle.getSnapshot().data).toBeUndefined()
  requests[1]!.resolve({ data: 'new', asOfSeq: 6 })
  await latest
  expect(handle.getSnapshot().data).toBe('new!')
})

test('stream epoch changes and resets refetch every active query; epochs discard old buffered deltas', async () => {
  const { queries, source } = setup()
  const first = definition('first')
  const second = definition('second')
  const inactive = definition('inactive')
  const handles = [queries.register(first.def), queries.register(second.def)]
  queries.register(inactive.def)
  handles.forEach((handle) => handle.subscribe(() => {}))
  hello(source)
  expect(first.fetch).toHaveBeenCalledTimes(1)
  delta(source, 100, 'old epoch')
  hello(source, 'epoch-two')
  expect(first.fetch).toHaveBeenCalledTimes(2)
  expect(second.fetch).toHaveBeenCalledTimes(2)
  expect(inactive.fetch).not.toHaveBeenCalled()
  delta(source, 2)
  first.requests[1]!.resolve({ data: 'new epoch', asOfSeq: 1 })
  second.requests[1]!.resolve({ data: 'second', asOfSeq: 1 })
  await vi.waitFor(() => expect(handles[0]!.getSnapshot().data).toBe('new epoch!'))
  source.frame({ type: 'stream.reset', data: { reason: 'pruned' } }, 'stream.reset')
  expect(first.fetch).toHaveBeenCalledTimes(3)
  expect(second.fetch).toHaveBeenCalledTimes(3)
})

test('after a reset, a failed refetch never applies buffered deltas to the old snapshot', async () => {
  const { queries, source } = setup()
  const { def, requests, reduce } = definition()
  const handle = queries.register(def)
  handle.subscribe(() => {})
  hello(source)
  await resolve(requests[0]!, 'before reset', 1)
  expect(handle.getSnapshot().data).toBe('before reset')
  source.frame({ type: 'stream.reset', data: { reason: 'pruned' } }, 'stream.reset')
  delta(source, 50, 'after a gap')
  requests[1]!.reject(new Error('offline'))
  await vi.waitFor(() => expect(handle.getSnapshot().status).toBe('error'))
  expect(handle.getSnapshot().data).toBe('before reset')
  expect(reduce).not.toHaveBeenCalled()
})

test('stream inactive queries ignore events and refetch on reactivation, rejecting old in-flight work', async () => {
  const { queries, source } = setup()
  const { def, requests, reduce, fetch } = definition()
  const handle = queries.register(def)
  const off = handle.subscribe(() => {})
  delta(source, 4, 'buffered')
  off()
  delta(source, 5, 'inactive')
  handle.subscribe(() => {})
  expect(fetch).toHaveBeenCalledTimes(2)
  requests[1]!.resolve({ data: 'current', asOfSeq: 2 })
  await vi.waitFor(() => expect(handle.getSnapshot().data).toBe('current'))
  await resolve(requests[0]!, 'stale', 0)
  expect(reduce).not.toHaveBeenCalled()
  expect(handle.getSnapshot().data).toBe('current')
})

test('stream queries recover from snapshot failures without losing buffered deltas', async () => {
  const { queries, source } = setup()
  const { def, requests } = definition()
  const handle = queries.register(def)
  handle.subscribe(() => {})
  delta(source, 2)
  requests[0]!.reject(new Error('offline'))
  await vi.waitFor(() => expect(handle.getSnapshot().status).toBe('error'))
  const retry = handle.refetch()
  requests[1]!.resolve({ data: 'recovered', asOfSeq: 1 })
  await retry
  expect(handle.getSnapshot()).toMatchObject({ data: 'recovered!', status: 'success' })
})

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

test('stream hook renders snapshots and live deltas using one connection in StrictMode', async () => {
  const { client, queries, source } = setup()
  const { def, requests } = definition()
  function Text() {
    const { data, status } = useStreamQuery(def)
    return <div>{status === 'success' ? data : 'Loading'}</div>
  }
  render(
    <StrictMode>
      <StreamContext value={{ client, queries }}>
        <Text />
      </StreamContext>
    </StrictMode>,
  )
  expect(screen.getByText('Loading')).toBeDefined()
  await act(async () => {
    requests.at(-1)!.resolve({ data: 'Hello', asOfSeq: 1 })
  })
  expect(screen.getByText('Hello')).toBeDefined()
  act(() => delta(source, 2, ' team'))
  expect(screen.getByText('Hello team')).toBeDefined()
  expect(MockEventSource.instances).toHaveLength(1)
})

test('stream watermarks belong to each query and multiple observers share one fetch', async () => {
  const { queries, source } = setup()
  const first = definition('first')
  const second = definition('second')
  const a = queries.register(first.def)
  const b = queries.register(second.def)
  const offA = a.subscribe(() => {})
  const offB = a.subscribe(() => {})
  b.subscribe(() => {})
  expect(first.fetch).toHaveBeenCalledTimes(1)
  first.requests[0]!.resolve({ data: 'a', asOfSeq: 2 })
  second.requests[0]!.resolve({ data: 'b', asOfSeq: 4 })
  await vi.waitFor(() => expect(a.getSnapshot().status).toBe('success'))
  delta(source, 3)
  expect(a.getSnapshot()).toMatchObject({ data: 'a!', asOfSeq: 3 })
  expect(b.getSnapshot()).toMatchObject({ data: 'b', asOfSeq: 4 })
  offA()
  delta(source, 5)
  expect(a.getSnapshot().data).toBe('a!!')
  offB()
})

test('stream failed refetch applies buffered deltas to the existing snapshot in sequence', async () => {
  const { queries, source } = setup()
  const { def, requests } = definition()
  const handle = queries.register(def)
  handle.subscribe(() => {})
  await resolve(requests[0]!, 'a', 1)
  const refetch = handle.refetch()
  delta(source, 2, 'b')
  requests[1]!.reject(new Error('offline'))
  await refetch
  expect(handle.getSnapshot()).toMatchObject({ data: 'ab', asOfSeq: 2, status: 'error' })
  delta(source, 3, 'c')
  expect(handle.getSnapshot().data).toBe('abc')
})

test('stream epoch recovery never applies new epoch deltas to old data after a fetch failure', async () => {
  const { queries, source } = setup()
  const { def, requests } = definition()
  const handle = queries.register(def)
  handle.subscribe(() => {})
  hello(source)
  await resolve(requests[0]!, 'old epoch', 100)
  hello(source, 'new epoch')
  delta(source, 2, 'b')
  requests[1]!.reject(new Error('offline'))
  await vi.waitFor(() => expect(handle.getSnapshot().status).toBe('error'))
  delta(source, 3, 'c')
  const retry = handle.refetch()
  requests[2]!.resolve({ data: 'a', asOfSeq: 1 })
  await retry
  expect(handle.getSnapshot()).toMatchObject({ data: 'abc', asOfSeq: 3 })
})

test('stream canonical cache entries remain observed while active and release on unmount', async () => {
  const { queries, queryClient } = setup()
  const { def, requests } = definition()
  const handle = queries.register(def)
  const off = handle.subscribe(() => {})
  await resolve(requests[0]!, 'active', 0)
  expect(queryClient.getQueryCache().find({ queryKey: def.key })?.getObserversCount()).toBe(1)
  off()
  expect(queryClient.getQueryCache().find({ queryKey: def.key })?.getObserversCount()).toBe(0)
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

test('stream reset keeps the durable cursor; changing epochs invalidates it until a new durable event', () => {
  vi.useFakeTimers()
  const { source } = setup()
  hello(source)
  delta(source, 7)
  source.frame({ type: 'stream.reset', data: { reason: 'pruned' } }, 'stream.reset')
  source.error()
  vi.advanceTimersByTime(500)
  const second = MockEventSource.instances.at(-1)!
  expect(second.url).toBe('/api/stream?since=7&epoch=epoch-one')
  hello(second, 'epoch-two')
  second.error()
  vi.advanceTimersByTime(500)
  expect(MockEventSource.instances.at(-1)!.url).toBe('/api/stream')
})
