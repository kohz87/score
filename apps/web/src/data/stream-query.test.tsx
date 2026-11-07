import { StrictMode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { StreamContext, useStreamQuery } from './query-client.ts'
import {
  definition,
  delta,
  hello,
  MockEventSource,
  queryClients,
  resolve,
  setup,
} from './stream-helpers.ts'

test('stream buffers refetch deltas, orders them and applies only those after the snapshot once', async () => {
  const { queries, queryClient, source, frames } = setup()
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
  frames.flush()
  expect(reduce).toHaveBeenCalledTimes(2)
  delta(source, 8)
  frames.flush()
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
  hello(source) // the first hello happens before any snapshot exists
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
  hello(source)
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

test('stream hook renders snapshots and live deltas using one connection in StrictMode', async () => {
  const { client, queries, source, frames } = setup()
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
  act(() => {
    delta(source, 2, ' team')
    frames.flush()
  })
  expect(screen.getByText('Hello team')).toBeDefined()
  expect(MockEventSource.instances).toHaveLength(1)
})

test('stream watermarks belong to each query and multiple observers share one fetch', async () => {
  const { queries, source, frames } = setup()
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
  frames.flush()
  expect(a.getSnapshot()).toMatchObject({ data: 'a!', asOfSeq: 3 })
  expect(b.getSnapshot()).toMatchObject({ data: 'b', asOfSeq: 4 })
  offA()
  delta(source, 5)
  frames.flush()
  expect(a.getSnapshot().data).toBe('a!!')
  offB()
})

test('stream failed refetch applies buffered deltas to the existing snapshot in sequence', async () => {
  const { queries, source, frames } = setup()
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
  frames.flush()
  expect(handle.getSnapshot().data).toBe('abc')
})

test('stream epoch recovery never applies new epoch deltas to old data after a fetch failure', async () => {
  const { queries, source } = setup()
  hello(source)
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

test('the first hello refetches snapshots fetched while the stream was still connecting', async () => {
  const { queries, source } = setup()
  const { def, requests } = definition()
  const handle = queries.register(def)
  handle.subscribe(() => {})
  // The snapshot completes before the stream ever connects, so it may predate the stream's head.
  await resolve(requests[0]!, 'early', 1)
  hello(source)
  expect(requests).toHaveLength(2)
  delta(source, 5, '!')
  requests[1]!.resolve({ data: 'fresh', asOfSeq: 4 })
  await vi.waitFor(() => expect(handle.getSnapshot().data).toBe('fresh!'))
  // Reconnecting to the same epoch is not a first hello.
  hello(source)
  expect(requests).toHaveLength(2)
})
