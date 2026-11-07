import { expect, test, vi } from 'vitest'
import { createStreamClient } from './stream.ts'
import { createQueryClient } from './query-client.ts'
import { createStreamQueryRegistry } from './resync.ts'
import {
  clients,
  definition,
  delta,
  hello,
  MockEventSource,
  queryClients,
  registries,
  resolve,
  setup,
} from './stream-helpers.ts'

async function settled(setupResult: ReturnType<typeof setup>, text: string, asOfSeq: number) {
  const { queries } = setupResult
  const made = definition()
  const handle = queries.register(made.def)
  const off = handle.subscribe(() => {})
  await resolve(made.requests[0]!, text, asOfSeq)
  return { ...made, handle, off }
}

test('batching applies a burst in one frame with a single cache write and one notification', async () => {
  const context = setup()
  const { source, frames, queryClient } = context
  const { handle, def, reduce, off } = await settled(context, 'a', 1)
  const set = vi.spyOn(queryClient, 'setQueryData')
  const notified = vi.fn()
  const stop = handle.subscribe(notified)
  for (let seq = 2; seq <= 51; seq++) delta(source, seq, String(seq % 10))
  expect(handle.getSnapshot()).toMatchObject({ data: 'a', asOfSeq: 1 })
  expect(frames.requested).toBe(1)
  frames.flush()
  expect(set).toHaveBeenCalledTimes(1)
  // Same notifications as a one-event frame (cache subscription plus the explicit publish).
  const perWrite = notified.mock.calls.length
  delta(source, 52, 'z')
  frames.flush()
  expect(notified).toHaveBeenCalledTimes(perWrite * 2)
  expect(reduce).toHaveBeenCalledTimes(51)
  expect(handle.getSnapshot().data).toBe(
    'a' + Array.from({ length: 50 }, (_, i) => (i + 2) % 10).join('') + 'z',
  )
  expect(queryClient.getQueryData(def.key)).toMatchObject({ asOfSeq: 52 })
  stop()
  off()
})

test('batching keeps arrival order and drops duplicates and old events across frames', async () => {
  const context = setup()
  const { source, frames } = context
  const { handle, reduce, off } = await settled(context, '', 1)
  delta(source, 2, 'b')
  delta(source, 2, 'X')
  delta(source, 4, 'd')
  delta(source, 3, 'Y')
  frames.flush()
  expect(handle.getSnapshot()).toMatchObject({ data: 'bd', asOfSeq: 4 })
  delta(source, 4, 'Z')
  delta(source, 5, 'e')
  frames.flush()
  expect(handle.getSnapshot()).toMatchObject({ data: 'bde', asOfSeq: 5 })
  delta(source, 1, 'old')
  frames.flush()
  expect(reduce).toHaveBeenCalledTimes(3)
  expect(handle.getSnapshot().asOfSeq).toBe(5)
  off()
})

test('batching a frame with only stale events writes nothing', async () => {
  const context = setup()
  const { source, frames, queryClient } = context
  const { handle, off } = await settled(context, 'a', 5)
  const set = vi.spyOn(queryClient, 'setQueryData')
  delta(source, 5)
  delta(source, 3)
  frames.flush()
  expect(set).not.toHaveBeenCalled()
  expect(handle.getSnapshot().data).toBe('a')
  off()
})

test('batching: a refetch applies already queued events first, ahead of events buffered during it', async () => {
  const context = setup()
  const { source, frames } = context
  const { handle, requests, off } = await settled(context, 'a', 1)
  delta(source, 2, 'b')
  delta(source, 3, 'c')
  const refetch = handle.refetch()
  delta(source, 4, 'd')
  delta(source, 5, 'e')
  frames.flush()
  // The snapshot covers the queued events (2, 3); 4 and 5 come from the buffer, deduplicated by seq.
  requests[1]!.resolve({ data: 'abc', asOfSeq: 3 })
  await refetch
  expect(handle.getSnapshot()).toMatchObject({ data: 'abcde', asOfSeq: 5, status: 'success' })
  off()
})

test('batching: a refetch that fails still keeps queued and buffered events in order', async () => {
  const context = setup()
  const { source, frames } = context
  const { handle, requests, off } = await settled(context, 'a', 1)
  delta(source, 2, 'b')
  const refetch = handle.refetch()
  delta(source, 3, 'c')
  requests[1]!.reject(new Error('offline'))
  await refetch
  frames.flush()
  expect(handle.getSnapshot()).toMatchObject({ data: 'abc', asOfSeq: 3, status: 'error' })
  off()
})

test('batching: a resync fence drops queued events so they never land on the old snapshot', async () => {
  const context = setup()
  const { source, frames } = context
  hello(source)
  const { handle, requests, reduce, off } = await settled(context, 'old', 1)
  hello(source)
  delta(source, 2, 'queued before the reset')
  source.frame({ type: 'stream.reset', data: { reason: 'pruned' } }, 'stream.reset')
  frames.flush()
  expect(reduce).not.toHaveBeenCalled()
  requests[1]!.reject(new Error('offline'))
  await vi.waitFor(() => expect(handle.getSnapshot().status).toBe('error'))
  expect(handle.getSnapshot().data).toBe('old')
  off()
})

test('batching: events queued before a resync are replaced by the new snapshot, later ones apply', async () => {
  const context = setup()
  const { source, frames } = context
  hello(source)
  const { handle, requests, off } = await settled(context, 'old', 1)
  hello(source)
  delta(source, 2, 'x')
  hello(source, 'epoch-two')
  delta(source, 3, 'c')
  requests[1]!.resolve({ data: 'fresh', asOfSeq: 2 })
  await vi.waitFor(() => expect(handle.getSnapshot().data).toBe('fresh!'.replace('!', 'c')))
  frames.flush()
  expect(handle.getSnapshot()).toMatchObject({ data: 'freshc', asOfSeq: 3 })
  off()
})

test('batching flushes queued events when the last observer leaves', async () => {
  const context = setup()
  const { source, frames, queryClient } = context
  const { def, off } = await settled(context, 'a', 1)
  delta(source, 2, 'b')
  off()
  expect(queryClient.getQueryData(def.key)).toEqual({ data: 'ab', asOfSeq: 2 })
  frames.flush()
  expect(queryClient.getQueryData(def.key)).toEqual({ data: 'ab', asOfSeq: 2 })
})

test('batching: each query gets its own write and dispose cancels the pending frame', async () => {
  const context = setup()
  const { source, frames, queries, queryClient } = context
  const first = await settled(context, 'a', 1)
  const secondDef = definition('second')
  const second = queries.register(secondDef.def)
  second.subscribe(() => {})
  await resolve(secondDef.requests[0]!, 'b', 1)
  const set = vi.spyOn(queryClient, 'setQueryData')
  delta(source, 2, '1')
  delta(source, 3, '2')
  expect(frames.requested).toBe(1)
  frames.flush()
  expect(set).toHaveBeenCalledTimes(2)
  expect(first.handle.getSnapshot().data).toBe('a12')
  expect(second.getSnapshot().data).toBe('b12')
  delta(source, 4, '3')
  expect(frames.pending).toBe(true)
  queries.dispose()
  expect(frames.pending).toBe(false)
})

test('default scheduler applies on an animation frame and does not lose events when hidden', async () => {
  const hidden = vi.spyOn(document, 'hidden', 'get')
  hidden.mockReturnValue(false)
  const client = createStreamClient({ EventSourceImpl: MockEventSource, random: () => 0.5 })
  const queryClient = createQueryClient()
  const queries = createStreamQueryRegistry(queryClient, client)
  clients.push(client)
  registries.push(queries)
  queryClients.push(queryClient)
  const source = MockEventSource.instances.at(-1)!
  const { def, requests } = definition()
  const handle = queries.register(def)
  handle.subscribe(() => {})
  await resolve(requests[0]!, 'a', 1)
  delta(source, 2, 'b')
  expect(handle.getSnapshot().data).toBe('a')
  await vi.waitFor(() => expect(handle.getSnapshot().data).toBe('ab'))
  // Hidden tabs get no animation frames: a short timer still delivers the batch.
  hidden.mockReturnValue(true)
  const raf = vi.spyOn(globalThis, 'requestAnimationFrame')
  delta(source, 3, 'c')
  delta(source, 4, 'd')
  expect(raf).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(handle.getSnapshot()).toMatchObject({ data: 'abcd', asOfSeq: 4 }))
})
