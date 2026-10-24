import type { StreamEvent } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../data/resync.ts'
import type { StreamClient } from '../data/stream.ts'
import { useBoldWorkbench } from './bold-workbench-queries.ts'

const workbench = { asOfSeq: 1, files: [], looseComments: [], drafts: [], screens: [] }

function Probe({ active, screen }: { active: string[]; screen: boolean }) {
  const data = useBoldWorkbench('job-feed', true, active, screen)
  return <span>{data.pending ? 'loading' : 'ready'}</span>
}

function mount({ active = ['builder'], screen = false } = {}) {
  const listeners = new Set<(event: StreamEvent) => void>()
  const stream = {
    subscribe(listener: (event: StreamEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onControl: () => () => undefined,
  }
  const calls: string[] = []
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input), 'http://score.test').pathname
    calls.push(path)
    if (path === '/api/jobs/job-feed/workbench') return Response.json(workbench)
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  const queries = createStreamQueryRegistry(
    queryClient,
    stream as unknown as StreamClient,
    immediateFrameScheduler,
  )
  const view = (next: { active?: string[]; screen?: boolean }) => (
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream as unknown as StreamClient, queries }}>
        <Probe active={next.active ?? active} screen={next.screen ?? screen} />
      </StreamContext>
    </QueryClientProvider>
  )
  const rendered = render(view({}))
  const cleanupMount = () => {
    queries.dispose()
    queryClient.clear()
    cleanup()
  }
  return {
    calls,
    emit(event: StreamEvent) {
      for (const listener of listeners) listener(event)
    },
    rerender(next: { active?: string[]; screen?: boolean }) {
      rendered.rerender(view(next))
    },
    cleanupMount,
  }
}

const event = (type: string, data: unknown, seq = 1): StreamEvent =>
  ({ seq, ts: '2026-10-24T10:00:00.000Z', type, data }) as StreamEvent

const frame = (agentId: string, seq: number) => ({
  seq,
  at: '2026-10-24T10:00:00.000Z',
  agentId,
  runId: 'run-feed',
  surface: 'terminal',
  terminal: { cwd: '/app', command: 'pnpm test', output: 'ok', status: 'ok' },
  caption: 'Ran the tests',
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('only a frame from an agent active in the job refreshes, and a burst reads once', async () => {
  const mounted = mount()
  expect(await screen.findByText('ready')).toBeDefined()
  expect(mounted.calls).toHaveLength(1)

  act(() => mounted.emit(event('watch.frame', frame('reviewer', 2), 2)))
  await new Promise((resolve) => setTimeout(resolve, 3200))
  expect(mounted.calls).toHaveLength(1)

  act(() => {
    mounted.emit(event('watch.frame', frame('builder', 3), 3))
    mounted.emit(event('watch.frame', frame('builder', 4), 4))
  })
  await waitFor(() => expect(mounted.calls).toHaveLength(2), { timeout: 4000 })
  mounted.cleanupMount()
})

test('an approval refresh waits until the Workbench shows a screen', async () => {
  const mounted = mount({ screen: false })
  expect(await screen.findByText('ready')).toBeDefined()
  expect(mounted.calls).toHaveLength(1)

  act(() => mounted.emit(event('approval.requested', { id: 'approval-1' }, 2)))
  await new Promise((resolve) => setTimeout(resolve, 3200))
  expect(mounted.calls).toHaveLength(1)

  mounted.rerender({ screen: true })
  act(() => mounted.emit(event('approval.requested', { id: 'approval-1' }, 3)))
  await waitFor(() => expect(mounted.calls).toHaveLength(2), { timeout: 4000 })
  mounted.cleanupMount()
})
