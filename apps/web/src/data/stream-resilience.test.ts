import { expect, test, vi } from 'vitest'
import { createStreamClient } from './stream.ts'
import { createQueryClient } from './query-client.ts'
import { createStreamQueryRegistry, defineStreamQuery, type StreamSnapshot } from './resync.ts'
import {
  clients,
  definition,
  delta,
  hello,
  MockEventSource,
  queryClients,
  registries,
} from './stream-helpers.ts'

function setupWith(options: Parameters<typeof createStreamQueryRegistry>[3]) {
  const client = createStreamClient({ EventSourceImpl: MockEventSource, random: () => 0.5 })
  const queryClient = createQueryClient()
  const queries = createStreamQueryRegistry(
    queryClient,
    client,
    (run) => (run(), () => {}),
    options,
  )
  clients.push(client)
  registries.push(queries)
  queryClients.push(queryClient)
  return { client, queryClient, queries, source: MockEventSource.instances.at(-1)! }
}

test('a failed fenced snapshot is retried with backoff and again on a plain reconnect', async () => {
  vi.useFakeTimers()
  const { queries, source } = setupWith({ retryBaseMs: 1000 })
  hello(source)
  const { def, requests } = definition()
  const handle = queries.register(def)
  handle.subscribe(() => {})
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  requests[0]!.resolve({ data: 'before', asOfSeq: 1 })
  await vi.waitFor(() => expect(handle.getSnapshot().data).toBe('before'))
  source.frame({ type: 'stream.reset', data: { reason: 'pruned' } }, 'stream.reset')
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  requests[1]!.reject(new Error('offline'))
  await vi.waitFor(() => expect(handle.getSnapshot().status).toBe('error'))
  delta(source, 5, '!')
  // The timer retries without any stream control.
  await vi.advanceTimersByTimeAsync(1000)
  expect(requests).toHaveLength(3)
  requests[2]!.reject(new Error('still offline'))
  await vi.waitFor(() => expect(handle.getSnapshot().status).toBe('error'))
  // A plain same-epoch reconnect retries at once, without waiting for the doubled delay.
  hello(source)
  expect(requests).toHaveLength(4)
  requests[3]!.resolve({ data: 'fresh', asOfSeq: 6 })
  await vi.waitFor(() => expect(handle.getSnapshot().data).toBe('fresh'))
  expect(handle.getSnapshot().status).toBe('success')
})

test('events held behind a fence are capped: overflow coalesces into one follow-up snapshot', async () => {
  const { queries, source } = setupWith({ maxBuffered: 3 })
  hello(source)
  const { def, requests } = definition()
  const handle = queries.register(def)
  handle.subscribe(() => {})
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  requests[0]!.resolve({ data: 'a', asOfSeq: 1 })
  await vi.waitFor(() => expect(handle.getSnapshot().data).toBe('a'))
  source.frame({ type: 'stream.reset', data: { reason: 'pruned' } }, 'stream.reset')
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  for (let seq = 10; seq < 14; seq++) delta(source, seq)
  // The slow snapshot is not superseded by a second concurrent request.
  expect(requests).toHaveLength(2)
  requests[1]!.resolve({ data: 'slow', asOfSeq: 9 })
  await vi.waitFor(() => expect(requests).toHaveLength(3))
  delta(source, 14, '!')
  requests[2]!.resolve({ data: 'fresh', asOfSeq: 13 })
  await vi.waitFor(() => expect(handle.getSnapshot().data).toBe('fresh!'))
})

// SCORE-012..016: the live-state state machine, one case per transition.
test('SCORE-012: a fence recorded while idle survives resubscribe with a failed fetch', async () => {
  const { queries, source } = setupWith({})
  hello(source)
  const { def, requests } = definition()
  const handle = queries.register(def)
  let off = handle.subscribe(() => {})
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  requests[0]!.resolve({ data: 'old', asOfSeq: 100 })
  await vi.waitFor(() => expect(handle.getSnapshot().data).toBe('old'))
  off()
  hello(source, 'epoch-two')
  off = handle.subscribe(() => {})
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  requests[1]!.reject(new Error('offline'))
  await vi.waitFor(() => expect(handle.getSnapshot().status).toBe('error'))
  // Sequence numbers restart per epoch; an event above the old cursor must still not land on it.
  delta(source, 101, '!')
  expect(handle.getSnapshot()).toMatchObject({ data: 'old', asOfSeq: 100 })
  requests[1]!.resolve({ data: 'unused', asOfSeq: 0 })
  off()
})

test('SCORE-013: a first snapshot that fails is retried on reconnect and by backoff', async () => {
  vi.useFakeTimers()
  const { queries, source } = setupWith({ retryBaseMs: 1000 })
  hello(source)
  const { def, requests } = definition()
  const handle = queries.register(def)
  handle.subscribe(() => {})
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  requests[0]!.reject(new Error('down'))
  await vi.waitFor(() => expect(handle.getSnapshot().status).toBe('error'))
  hello(source)
  expect(requests).toHaveLength(2)
  requests[1]!.reject(new Error('down'))
  await vi.waitFor(() => expect(handle.getSnapshot().status).toBe('error'))
  await vi.advanceTimersByTimeAsync(2000)
  expect(requests).toHaveLength(3)
  requests[2]!.resolve({ data: 'ok', asOfSeq: 1 })
  await vi.waitFor(() => expect(handle.getSnapshot().data).toBe('ok'))
})

test('SCORE-014: an unfenced load that never settles keeps the buffer bounded and recovers', async () => {
  const { queries, source } = setupWith({ maxBuffered: 3 })
  hello(source)
  const { def, requests } = definition()
  const handle = queries.register(def)
  handle.subscribe(() => {})
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  for (let seq = 1; seq <= 50; seq++) delta(source, seq)
  expect(requests).toHaveLength(1)
  requests[0]!.resolve({ data: 'stale', asOfSeq: 0 })
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  requests[1]!.resolve({ data: 'good', asOfSeq: 50 })
  await vi.waitFor(() => expect(handle.getSnapshot()).toMatchObject({ data: 'good', asOfSeq: 50 }))
})

test('SCORE-014/015: a hung snapshot is aborted at the deadline and reported as an error', async () => {
  vi.useFakeTimers()
  const { queries } = setupWith({ snapshotTimeoutMs: 5000 })
  const signals: (AbortSignal | undefined)[] = []
  const def = defineStreamQuery<string>({
    key: ['hung'],
    fetch: (signal) => {
      signals.push(signal)
      return new Promise(() => {})
    },
    types: [],
    reduce: (data) => data,
  })
  const handle = queries.register(def)
  handle.subscribe(() => {})
  await vi.advanceTimersByTimeAsync(5000)
  expect(signals[0]?.aborted).toBe(true)
  expect(handle.getSnapshot().status).toBe('error')
})

test('SCORE-015: repeated overflow with slow snapshots keeps one request in flight and a superseded one is aborted', async () => {
  const { queries, source } = setupWith({ maxBuffered: 2 })
  hello(source)
  const signals: AbortSignal[] = []
  const requests: ReturnType<typeof Promise.withResolvers<StreamSnapshot<string>>>[] = []
  const def = defineStreamQuery<string>({
    key: ['slow'],
    fetch: (signal) => {
      signals.push(signal!)
      const request = Promise.withResolvers<StreamSnapshot<string>>()
      requests.push(request)
      return request.promise
    },
    types: ['message.delta'],
    reduce: (data, event) => (event.type === 'message.delta' ? data + event.data.append : data),
  })
  const handle = queries.register(def)
  handle.subscribe(() => {})
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  for (let round = 0; round < 3; round++) {
    for (let index = 0; index < 5; index++) delta(source, round * 10 + index + 1)
    expect(requests).toHaveLength(round + 1)
    requests[round]!.resolve({ data: 'x', asOfSeq: 0 })
    await vi.waitFor(() => expect(requests).toHaveLength(round + 2))
  }
  // A reset supersedes the in-flight request and cancels it.
  source.frame({ type: 'stream.reset', data: { reason: 'pruned' } }, 'stream.reset')
  await vi.waitFor(() => expect(requests).toHaveLength(5))
  expect(signals[3]!.aborted).toBe(true)
  requests[4]!.resolve({ data: 'done', asOfSeq: 99 })
  await vi.waitFor(() => expect(handle.getSnapshot().data).toBe('done'))
})

test('SCORE-016: a handle kept across idle eviction reads and refetches the fresh registration', async () => {
  vi.useFakeTimers()
  const { queries } = setupWith({ idleEvictMs: 1000 })
  const { def, requests } = definition()
  const old = queries.register(def)
  const off = old.subscribe(() => {})
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  requests[0]!.resolve({ data: 'one', asOfSeq: 1 })
  await vi.waitFor(() => expect(old.getSnapshot().data).toBe('one'))
  off()
  await vi.advanceTimersByTimeAsync(1000)
  const listener = vi.fn()
  old.subscribe(listener)
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  requests[1]!.resolve({ data: 'two', asOfSeq: 2 })
  await vi.waitFor(() => expect(old.getSnapshot().data).toBe('two'))
  expect(listener).toHaveBeenCalled()
  void old.refetch()
  await vi.waitFor(() => expect(requests).toHaveLength(3))
  requests[2]!.resolve({ data: 'three', asOfSeq: 3 })
  await vi.waitFor(() => expect(old.getSnapshot().data).toBe('three'))
})

test('S3-006: events dropped while idle make the cache stale; a failed refresh never turns a later delta into success', async () => {
  vi.useFakeTimers()
  const { queries, source } = setupWith({ retryBaseMs: 1000 })
  hello(source)
  const { def, requests } = definition()
  const handle = queries.register(def)
  let off = handle.subscribe(() => {})
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  requests[0]!.resolve({ data: 'A', asOfSeq: 10 })
  await vi.waitFor(() => expect(handle.getSnapshot().data).toBe('A'))
  off()
  // A changes while nobody observes; the event is dropped. Same epoch, no reconnect.
  delta(source, 11, '+')
  off = handle.subscribe(() => {})
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  requests[1]!.reject(new Error('offline'))
  await vi.waitFor(() => expect(handle.getSnapshot().status).toBe('error'))
  delta(source, 12, 'B')
  expect(handle.getSnapshot()).toMatchObject({ status: 'error', data: 'A', asOfSeq: 10 })
  // Backoff retries; the new snapshot (taken after B) repairs it.
  await vi.advanceTimersByTimeAsync(1000)
  expect(requests).toHaveLength(3)
  requests[2]!.resolve({ data: 'A+B', asOfSeq: 12 })
  await vi.waitFor(() =>
    expect(handle.getSnapshot()).toMatchObject({ status: 'success', data: 'A+B', asOfSeq: 12 }),
  )
  off()
})

test('S4-001: leaving during a refresh fences the buffered events; a failed reopen never publishes success without them', async () => {
  vi.useFakeTimers()
  const { queries, source } = setupWith({ retryBaseMs: 1000 })
  hello(source)
  const { def, requests } = definition()
  const handle = queries.register(def)
  let off = handle.subscribe(() => {})
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  requests[0]!.resolve({ data: 'A', asOfSeq: 10 })
  await vi.waitFor(() => expect(handle.getSnapshot().data).toBe('A'))
  // A refresh is held in flight; update 11 is buffered behind it, then the page is left.
  void handle.refetch()
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  delta(source, 11, '+')
  off()
  off = handle.subscribe(() => {})
  await vi.waitFor(() => expect(requests).toHaveLength(3))
  requests[2]!.reject(new Error('offline'))
  await vi.waitFor(() => expect(handle.getSnapshot().status).toBe('error'))
  delta(source, 12, 'B')
  expect(handle.getSnapshot()).toMatchObject({ status: 'error', data: 'A', asOfSeq: 10 })
  await vi.advanceTimersByTimeAsync(1000)
  expect(requests).toHaveLength(4)
  requests[3]!.resolve({ data: 'A+B', asOfSeq: 12 })
  await vi.waitFor(() =>
    expect(handle.getSnapshot()).toMatchObject({ status: 'success', data: 'A+B', asOfSeq: 12 }),
  )
  off()
})

test('an unobserved registration is evicted after the idle period and registers again on next use', async () => {
  vi.useFakeTimers()
  const { queries, queryClient } = setupWith({ idleEvictMs: 1000 })
  // TanStack keeps its subscribers private; the count is what leaked before.
  const cacheListeners = () =>
    (queryClient.getQueryCache() as unknown as { listeners: Set<unknown> }).listeners.size
  const baseline = cacheListeners()
  const handles = Array.from({ length: 20 }, (_, index) => {
    const { def, requests } = definition(`page-${index}`)
    const handle = queries.register(def)
    const off = handle.subscribe(() => {})
    off()
    return { def, handle, requests }
  })
  expect(cacheListeners()).toBe(baseline + 20)
  await vi.advanceTimersByTimeAsync(1000)
  expect(cacheListeners()).toBe(baseline)
  const again = handles[0]!
  expect(queries.register(again.def)).not.toBe(again.handle)
  // A holder of the old handle is moved to the fresh registration instead of a dead one.
  const off = again.handle.subscribe(() => {})
  expect(cacheListeners()).toBe(baseline + 1)
  off()
})

test('a re-subscribe inside the idle period keeps the registration', async () => {
  vi.useFakeTimers()
  const { queries } = setupWith({ idleEvictMs: 1000 })
  const { def } = definition()
  const handle = queries.register(def)
  handle.subscribe(() => {})()
  await vi.advanceTimersByTimeAsync(500)
  handle.subscribe(() => {})
  await vi.advanceTimersByTimeAsync(5000)
  expect(queries.register(def)).toBe(handle)
})
