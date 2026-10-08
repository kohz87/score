import { watchQuery } from './watch-queries.ts'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { StreamEvent } from '@score/contract'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  watchApprovalFixture,
  watchFixture,
  watchOverviewFixture,
} from '../../../../../e2e/watch-fixture.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { WatchPage } from './WatchPage.tsx'

class Source extends EventTarget {
  static current: Source
  constructor() {
    super()
    Source.current = this
  }
  close() {}
}
let sharedApprovals: unknown[]
let currentSession: string
let requests: { url: string; init?: RequestInit }[]
const dispose: (() => void)[] = []
const json = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status }))

beforeEach(() => {
  requests = []
  sharedApprovals = [watchApprovalFixture]
  currentSession = 'score-room-activity-feed-builder'
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, ...(init ? { init } : {}) })
      if (url === '/api/agents/builder/watch?limit=1')
        return json({ ...watchFixture, sessionId: currentSession })
      if (url.startsWith('/api/agents/builder/watch?limit=500')) return json(watchFixture)
      if (url === '/api/approvals?status=pending&agent=builder')
        return json({ asOfSeq: 1, items: [watchApprovalFixture], nextCursor: null })
      if (url === '/api/agents/nobody/watch?limit=500')
        return json({ error: { code: 'not_found', message: 'Agent not found' } }, 404)
      if (url === '/api/watch/overview') return json(watchOverviewFixture)
      if (url === '/api/approvals?status=all')
        return json({ asOfSeq: 1, items: sharedApprovals, nextCursor: null })
      if (url.endsWith('/pause'))
        return json({ ...watchFixture.agent, status: 'paused', activity: 'Paused' })
      return json({ error: { code: 'not_found', message: 'Missing fixture' } }, 404)
    }),
  )
})
afterEach(() => {
  cleanup()
  dispose.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function setup(agentId = 'builder', search = '') {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  dispose.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  const router = createMemoryRouter([{ path: '/now/watch/:agentId', element: <WatchPage /> }], {
    initialEntries: [`/now/watch/${agentId}${search}`],
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}
function emit(event: Omit<StreamEvent, 'seq' | 'ts'>, seq: number) {
  act(() =>
    Source.current.dispatchEvent(
      new MessageEvent(event.type, {
        data: JSON.stringify({ ...event, seq, ts: '2026-10-08T21:32:00.000Z' }),
        lastEventId: String(seq),
      }),
    ),
  )
}

test('the page shows the live stage, the approval bar, the timeline and both side panels', async () => {
  setup()
  expect(await screen.findByRole('heading', { name: 'Watching builder', level: 1 })).toBeTruthy()
  expect(screen.getByText("You're watching. builder is in control.")).toBeTruthy()
  expect(screen.getByRole('group', { name: 'Terminal' }).getAttribute('data-front')).toBe('true')
  expect(screen.getByRole('group', { name: 'Approval needed' }).textContent).toContain(
    'npm install ws@8',
  )
  expect(
    within(screen.getByRole('group', { name: 'Replay timeline' })).getAllByRole('button'),
  ).toHaveLength(watchFixture.markers.length)
  expect(screen.getByRole('heading', { name: 'What builder is doing' })).toBeTruthy()
  expect(await screen.findByRole('link', { name: /reviewer/ })).toBeTruthy()
  // Take control is out of scope: the page offers pause and a terminal command instead.
  expect(screen.queryByRole('button', { name: /take control/i })).toBeNull()
  expect(screen.getByRole('button', { name: 'Pause builder' })).toBeTruthy()
  expect(
    screen.getByText(
      'Pausing builder stops new work after the current step; Open in terminal lets you continue the same session yourself.',
    ),
  ).toBeTruthy()
})

test('scrubbing back replays that moment and Live snaps back', async () => {
  setup()
  await screen.findByRole('heading', { name: 'Watching builder' })
  const track = screen.getByRole('group', { name: 'Replay timeline' })
  fireEvent.click(within(track).getAllByRole('button')[1]!)
  expect(screen.getByRole('status', { name: '' }).textContent).toMatch(/^Replaying \d\d:\d\d$/)
  expect(screen.getByRole('group', { name: 'Editor' }).getAttribute('data-front')).toBe('true')
  expect(screen.queryByRole('group', { name: 'Browser' })).toBeNull()
  expect(screen.queryByRole('group', { name: 'Approval needed' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Back to live' }))
  expect(screen.getByText("You're watching. builder is in control.")).toBeTruthy()
  expect(screen.getByRole('group', { name: 'Approval needed' })).toBeTruthy()
})

test("?from= (History's Replay in Watch) opens the replay at that moment", async () => {
  const first = Math.min(...watchFixture.markers.map((marker) => marker.seq))
  setup('builder', `?from=${first}`)
  await screen.findByRole('heading', { name: 'Watching builder' })
  expect(screen.getByRole('button', { name: 'Back to live' })).toBeTruthy()
  expect(screen.getByRole('status', { name: '' }).textContent).toMatch(/^Replaying \d\d:\d\d$/)
})

test('playing a replay steps forward and lands back on live', async () => {
  setup()
  await screen.findByRole('heading', { name: 'Watching builder' })
  const track = screen.getByRole('group', { name: 'Replay timeline' })
  const total = within(track).getAllByRole('button').length
  fireEvent.click(within(track).getAllByRole('button')[total - 3]!)
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole('button', { name: 'Play' }))
  for (let step = 0; step < 3; step += 1) act(() => void vi.advanceTimersByTime(1000))
  expect(screen.getByText("You're watching. builder is in control.")).toBeTruthy()
})

test('a frozen replay stays on its moment when a live event shifts the marker list', async () => {
  setup()
  await screen.findByRole('heading', { name: 'Watching builder' })
  const track = screen.getByRole('group', { name: 'Replay timeline' })
  fireEvent.click(within(track).getAllByRole('button')[1]!)
  expect(screen.getByRole('group', { name: 'Editor' }).getAttribute('data-front')).toBe('true')
  // A question asked just after the first frame lands before the selected marker and shifts every later index.
  const first = watchFixture.frames[0]!
  emit(
    {
      type: 'approval.requested',
      data: {
        ...watchApprovalFixture,
        id: 'early-question',
        createdAt: new Date(Date.parse(first.at) + 1000).toISOString(),
      },
    } as StreamEvent,
    5,
  )
  expect(within(track).getAllByRole('button')).toHaveLength(watchFixture.markers.length + 1)
  expect(screen.getByRole('status', { name: '' }).textContent).toMatch(/^Replaying/)
  expect(screen.getByRole('group', { name: 'Editor' }).getAttribute('data-front')).toBe('true')
})

test('a live frame with a known seq updates in place and a new one extends the stage and the timeline', async () => {
  setup()
  await screen.findByRole('heading', { name: 'Watching builder' })
  const before = within(screen.getByRole('group', { name: 'Replay timeline' })).getAllByRole(
    'button',
  ).length
  const last = watchFixture.frames.at(-1)!
  emit(
    {
      type: 'watch.frame',
      data: {
        ...last,
        terminal: { ...last.terminal!, output: 'added 1 package', status: 'ok' },
      },
    } as StreamEvent,
    2,
  )
  expect(screen.getByText('added 1 package')).toBeTruthy()
  expect(
    within(screen.getByRole('group', { name: 'Replay timeline' })).getAllByRole('button'),
  ).toHaveLength(before)
  emit(
    {
      type: 'watch.frame',
      data: {
        seq: last.seq + 1,
        at: '2026-10-08T21:32:00.000Z',
        agentId: 'builder',
        runId: null,
        surface: 'browser',
        browser: { url: 'http://localhost:5173/done', title: 'Done', imageUrl: null },
        caption: 'Looked at the finished page',
      },
    } as StreamEvent,
    3,
  )
  expect(screen.getByRole('group', { name: 'Browser' }).getAttribute('data-front')).toBe('true')
  expect(
    within(screen.getByRole('group', { name: 'Replay timeline' })).getAllByRole('button'),
  ).toHaveLength(before + 1)
  expect(screen.getByText('Looked at the finished page')).toBeTruthy()
})

test('pause posts once with an idempotency key and the button follows the agent status from the stream', async () => {
  setup()
  fireEvent.click(await screen.findByRole('button', { name: 'Pause builder' }))
  await waitFor(() => expect(requests.some((request) => request.url.endsWith('/pause'))).toBe(true))
  const post = requests.find((request) => request.url.endsWith('/pause'))!
  expect(post.url).toBe('/api/agents/builder/pause')
  expect(new Headers(post.init?.headers).get('Idempotency-Key')).toBeTruthy()
  emit(
    { type: 'agent.updated', data: { ...watchFixture.agent, status: 'paused' } } as StreamEvent,
    2,
  )
  expect(await screen.findByRole('button', { name: 'Resume builder' })).toBeTruthy()
})

test('one run ending does not mark the agent idle; the agent update decides', async () => {
  setup()
  await screen.findByRole('heading', { name: 'Watching builder', level: 1 })
  const run = {
    id: 'run-b',
    agentId: 'builder',
    origin: 'score',
    status: 'completed',
    startedAt: '2026-10-08T21:30:00.000Z',
    endedAt: '2026-10-08T21:31:00.000Z',
    model: null,
    toolsUsed: [],
    tokens: null,
    costUsd: null,
    refs: [],
    gaps: [],
  }
  emit({ type: 'run.updated', data: run } as unknown as StreamEvent, 2)
  const { reduce } = watchQuery('builder')
  const ended = { type: 'run.updated', data: run } as unknown as StreamEvent
  expect(reduce({ ...watchFixture, live: true }, ended).live).toBe(true)
  const idle = { type: 'agent.updated', data: { ...watchFixture.agent, status: 'idle' } }
  expect(reduce({ ...watchFixture, live: true }, idle as unknown as StreamEvent).live).toBe(false)
  emit(
    {
      type: 'gap.recorded',
      data: {
        source: 'run-sse:builder',
        runId: 'run-b',
        from: run.startedAt,
        to: run.endedAt,
        reason: 'x',
      },
    } as StreamEvent,
    3,
  )
  expect(await screen.findByText(/Some events were not recorded \(1 gap\)/)).toBeTruthy()
})

test('open in terminal copies the resume command and confirms it', async () => {
  const writeText = vi.fn(() => Promise.resolve())
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  setup()
  fireEvent.click(await screen.findByRole('button', { name: 'Open in terminal' }))
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(
      'hermes -p builder --resume score-room-activity-feed-builder',
    ),
  )
  expect((await screen.findByText(/^Copied\./)).textContent).toContain(
    'hermes -p builder --resume score-room-activity-feed-builder',
  )
})

test('an unknown agent says so', async () => {
  setup('nobody')
  expect((await screen.findByRole('alert')).textContent).toContain('That agent does not exist')
})

test('an outstanding approval shows even when the shared newest-approvals list no longer holds it', async () => {
  sharedApprovals = []
  setup()
  expect(await screen.findByRole('group', { name: 'Approval needed' })).toBeTruthy()
  expect(requests.some((item) => item.url === '/api/approvals?status=pending&agent=builder')).toBe(
    true,
  )
})

test('the replay window is requested from the moment asked for', async () => {
  const first = Math.min(...watchFixture.markers.map((marker) => marker.seq))
  setup('builder', `?from=${first}`)
  await screen.findByRole('heading', { name: 'Watching builder' })
  expect(requests.some((item) => item.url.endsWith(`watch?limit=500&from=${first}`))).toBe(true)
})

test('scrubbing to a moment outside the loaded frames re-anchors the window there', async () => {
  const late = Math.max(...watchFixture.markers.map((marker) => marker.seq))
  const frames = watchFixture.frames.filter((frame) => frame.seq < late)
  const fetchMock = vi.mocked(globalThis.fetch)
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((input, init) =>
    String(input) === '/api/agents/builder/watch?limit=500'
      ? json({ ...watchFixture, frames })
      : original(input, init),
  )
  setup()
  await screen.findByRole('heading', { name: 'Watching builder' })
  const track = screen.getByRole('group', { name: 'Replay timeline' })
  const buttons = within(track).getAllByRole('button')
  fireEvent.click(buttons[buttons.length - 1]!)
  await waitFor(() =>
    expect(requests.some((item) => item.url.endsWith(`watch?limit=500&from=${late}`))).toBe(true),
  )
})

test('open in terminal uses the session the agent is on now, not the one from page load', async () => {
  const copied = vi.fn(() => Promise.resolve())
  vi.stubGlobal('navigator', { clipboard: { writeText: copied } })
  setup()
  await screen.findByRole('heading', { name: 'Watching builder' })
  currentSession = 'session-two'
  fireEvent.click(screen.getByRole('button', { name: 'Open in terminal' }))
  expect(await screen.findByText('hermes -p builder --resume session-two')).toBeTruthy()
})

test('a paused agent whose last run ends re-reads Watch so it stops showing live', async () => {
  setup()
  await screen.findByRole('heading', { name: 'Watching builder', level: 1 })
  emit(
    { type: 'agent.updated', data: { ...watchFixture.agent, status: 'paused' } } as StreamEvent,
    2,
  )
  await screen.findByRole('button', { name: 'Resume builder' })
  const reads = () =>
    requests.filter((r) => r.url.startsWith('/api/agents/builder/watch?limit=500')).length
  const before = reads()
  const run = {
    id: 'run-z',
    agentId: 'builder',
    origin: 'score',
    status: 'completed',
    startedAt: '2026-10-08T21:30:00.000Z',
    endedAt: '2026-10-08T21:31:00.000Z',
    model: null,
    toolsUsed: [],
    tokens: null,
    costUsd: null,
    refs: [],
    gaps: [],
  }
  emit({ type: 'run.updated', data: run } as unknown as StreamEvent, 3)
  await waitFor(() => expect(reads()).toBe(before + 1))
})
