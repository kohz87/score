import type { JobResults, StreamEvent } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../data/resync.ts'
import type { StreamClient } from '../data/stream.ts'
import { useJobResults } from './bold-results-queries.ts'

// was (BoldResults.test.tsx): the stream-refresh tests of useBoldResults, now for the one-topic hook.
const empty: JobResults = { asOfSeq: 1, items: [], screens: [] }
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanup()
  cleanups.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})

function Probe({ jobId, visible = true }: { jobId: string | null; visible?: boolean }): ReactNode {
  const { results, failed, retry } = useJobResults(jobId, visible)
  return (
    <div>
      <span data-testid="seq">{results?.asOfSeq ?? 'none'}</span>
      <span data-testid="failed">{String(failed)}</span>
      <button type="button" onClick={retry}>
        retry
      </button>
    </div>
  )
}

const screen1 = {
  agentId: 'builder',
  seq: 3,
  surface: 'terminal' as const,
  caption: 'tests',
  live: true,
  at: '2026-10-24T10:00:00.000Z',
}

function mount(
  props: { jobId: string | null; visible?: boolean },
  fail = () => false,
  withScreen = false,
) {
  const listeners = new Set<(event: StreamEvent) => void>()
  const stream = {
    subscribe(listener: (event: StreamEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onControl: () => () => undefined,
  }
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://score.test').pathname
      calls.push(path)
      if (fail())
        return Response.json({ error: { code: 'unavailable', message: 'x' } }, { status: 503 })
      return Response.json({
        ...empty,
        screens: withScreen ? [screen1] : [],
        asOfSeq: calls.length,
      })
    }),
  )
  const queryClient = createQueryClient()
  const queries = createStreamQueryRegistry(
    queryClient,
    stream as unknown as StreamClient,
    immediateFrameScheduler,
  )
  cleanups.push(() => {
    queries.dispose()
    queryClient.clear()
  })
  const tree = (next: { jobId: string | null; visible?: boolean }) => (
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream as unknown as StreamClient, queries }}>
        <Probe {...next} />
      </StreamContext>
    </QueryClientProvider>
  )
  const view = render(tree(props))
  return {
    rerender: (next: { jobId: string | null; visible?: boolean }) => view.rerender(tree(next)),
    calls,
    emit(event: StreamEvent) {
      for (const listener of listeners) listener(event)
    },
  }
}

const event = (type: string, data: unknown): StreamEvent =>
  ({ seq: 2, ts: '2026-10-24T10:00:00.000Z', type, data }) as StreamEvent

test('events for the topic refresh it once for a burst; other topics and token updates do not', async () => {
  const mounted = mount({ jobId: 'job-a' })
  await waitFor(() => expect(screen.getByTestId('seq').textContent).toBe('1'))
  act(() => {
    mounted.emit(event('job.upserted', { id: 'job-a' }))
    mounted.emit(event('job.upserted', { id: 'job-a' }))
    mounted.emit(event('job.upserted', { id: 'job-b' }))
    mounted.emit(event('message.updated', { roomId: 'team', messageId: 'm1' }))
  })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await waitFor(() =>
    expect(mounted.calls).toEqual(['/api/jobs/job-a/results', '/api/jobs/job-a/results']),
  )
})

test('a failed read says so and a Retry reads again', async () => {
  let down = true
  const mounted = mount({ jobId: 'job-a' }, () => down)
  await waitFor(() => expect(screen.getByTestId('failed').textContent).toBe('true'))
  down = false
  act(() => screen.getByRole('button', { name: 'retry' }).click())
  await waitFor(() => expect(screen.getByTestId('failed').textContent).toBe('false'))
  expect(mounted.calls).toHaveLength(2)
})

test('no topic, or a hidden panel, reads nothing', async () => {
  const none = mount({ jobId: null })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(none.calls).toEqual([])
  cleanup()
  const hidden = mount({ jobId: 'job-a', visible: false })
  act(() => hidden.emit(event('job.upserted', { id: 'job-a' })))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(hidden.calls).toEqual([])
})

const frame = (agentId: string) => event('watch.frame', { agentId, seq: 9 })

test('a watch frame refreshes, coalesced, only from an agent with a screen in this topic', async () => {
  const mounted = mount({ jobId: 'job-a' }, () => false, true)
  await waitFor(() => expect(screen.getByTestId('seq').textContent).toBe('1'))
  act(() => {
    mounted.emit(frame('someone-else'))
    mounted.emit(frame('other-screen'))
  })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  expect(mounted.calls).toHaveLength(1)
  act(() => {
    mounted.emit(frame('builder'))
    mounted.emit(frame('builder'))
    mounted.emit(frame('builder'))
  })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await waitFor(() => expect(mounted.calls).toHaveLength(2))
  expect(screen.getByTestId('seq').textContent).toBe('2')
})

test('a watch frame refreshes and a later success clears an error', async () => {
  let down = false
  const mounted = mount({ jobId: 'job-a' }, () => down, true)
  await waitFor(() => expect(screen.getByTestId('seq').textContent).toBe('1'))
  down = true
  act(() => mounted.emit(frame('builder')))
  await waitFor(() => expect(screen.getByTestId('failed').textContent).toBe('true'), {
    timeout: 3000,
  })
  down = false
  act(() => mounted.emit(frame('builder')))
  await waitFor(() => expect(screen.getByTestId('failed').textContent).toBe('false'), {
    timeout: 3000,
  })
})

test('a hidden section reads nothing and reads once when it shows again', async () => {
  const mounted = mount({ jobId: 'job-a', visible: false }, () => false, true)
  act(() => {
    mounted.emit(frame('builder'))
    mounted.emit(event('job.upserted', { id: 'job-a' }))
  })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  expect(mounted.calls).toEqual([])
  mounted.rerender({ jobId: 'job-a', visible: true })
  await waitFor(() => expect(mounted.calls).toHaveLength(1))
  mounted.rerender({ jobId: 'job-a', visible: false })
  act(() => mounted.emit(frame('builder')))
  await new Promise((resolve) => setTimeout(resolve, 1100))
  expect(mounted.calls).toHaveLength(1)
  mounted.rerender({ jobId: 'job-a', visible: true })
  await waitFor(() => expect(mounted.calls).toHaveLength(2))
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(mounted.calls).toHaveLength(2)
})
