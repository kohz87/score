import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { flowFixture } from '../../../../../../e2e/flow-fixture.ts'
import { createQueryClient, StreamContext } from '../../../data/query-client.ts'
import { createStreamClient } from '../../../data/stream.ts'
import { createStreamQueryRegistry } from '../../../data/resync.ts'
import { FlowView } from './FlowView.tsx'

class Source extends EventTarget {
  static current: Source
  constructor() {
    super()
    Source.current = this
  }
  close() {}
}
let fixture: ReturnType<typeof flowFixture>
let requests: { url: string; init?: RequestInit }[]
let stopStatus: number
let nodeStatus: number
let pauseFails = false
let flowDelayMs = 0
const dispose: (() => void)[] = []
const response = (data: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(data), { status }))
beforeEach(() => {
  fixture = flowFixture('room-flow')
  requests = []
  stopStatus = 200
  nodeStatus = 200
  pauseFails = false
  flowDelayMs = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, ...(init ? { init } : {}) })
      if (url === '/api/agents') return response({ asOfSeq: 1, items: fixture.agents })
      if (url === '/api/rooms')
        return response({
          asOfSeq: 1,
          rooms: [
            {
              id: 'room-flow',
              name: '#flow',
              kind: 'room',
              leadAgentId: 'lead',
              members: fixture.agents.map((agent) => agent.id),
              unread: 0,
              activeAgents: [],
              channels: [],
            },
          ],
          directs: [],
        })
      if (url.startsWith('/api/briefs?'))
        return response({ items: url.endsWith('active') ? [fixture.flow.brief] : [] })
      if (url.endsWith('/pause')) {
        if (pauseFails) {
          fixture.flow.brief.status = 'paused'
          return response(
            { error: { code: 'upstream_failed', message: '1 task could not be held.' } },
            502,
          )
        }
        return response({ ...fixture.flow.brief, status: 'paused' })
      }
      if (url.endsWith('/flow')) {
        if (flowDelayMs === 0) return response(fixture.flow)
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(new Response(JSON.stringify(fixture.flow))),
            flowDelayMs,
          )
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      }
      if (url.includes('/log?')) {
        const params = new URL(url, 'http://localhost').searchParams
        const items = fixture.log.items.filter(
          (line) =>
            (!params.has('agent') || line.agentId === params.get('agent')) &&
            (params.get('kind') !== 'tool' || line.kind === 'tool'),
        )
        return response({ items, nextCursor: null })
      }
      if (url.includes('/stop'))
        return response(
          stopStatus === 200
            ? { ok: true }
            : stopStatus === 501
              ? { error: { code: 'unsupported', message: 'Stop is not available for this run.' } }
              : { error: { code: 'conflict', message: 'Nothing is running in this step' } },
          stopStatus,
        )
      if (url.startsWith('/api/flow/nodes/'))
        return response(
          nodeStatus === 200
            ? fixture.detail
            : { error: { code: 'not_found', message: 'Unknown flow node' } },
          nodeStatus,
        )
      if (url === '/api/approvals?status=all')
        return response({ asOfSeq: 1, items: [fixture.detail.approval], nextCursor: null })
      if (url.endsWith('/decision'))
        return response({
          ...fixture.detail.approval,
          status: 'approved',
          phase: 'decided',
          actionable: false,
          delivery: 'applied',
          decision: { by: 'you', choice: 'once', at: '2026-10-08T21:31:00.000Z' },
        })
      return response({ error: { code: 'not_found', message: 'Missing fixture' } }, 404)
    }),
  )
})
afterEach(() => {
  cleanup()
  dispose.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})
function setup(path = '/now/flow/fixture-flow') {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  dispose.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  const router = createMemoryRouter([{ path: '/now/flow/:briefId', element: <FlowView /> }], {
    initialEntries: [path],
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}

test('selects the waiting node and renders its checklist, approval, facts, Chat link and stats', async () => {
  setup()
  const inspector = await screen.findByRole('complementary', { name: 'Selected step' })
  expect(await within(inspector).findByRole('heading', { name: 'Event stream' })).toBeTruthy()
  expect(within(inspector).getByRole('list', { name: 'Steps' }).children).toHaveLength(4)
  expect(within(inspector).getByText('Completed:')).toBeTruthy()
  expect(within(inspector).getByText('Demo model')).toBeTruthy()
  expect(within(inspector).getByText('terminal, files')).toBeTruthy()
  expect(within(inspector).getByText('No desktop open for this step')).toBeTruthy()
  expect(within(inspector).getByRole('link', { name: 'Open in Chat' }).getAttribute('href')).toBe(
    '/chat/room-flow',
  )
  const stats = screen.getByRole('region', { name: 'This run so far' })
  for (const value of ['61 min', '41', '6', '$1.84'])
    expect(within(stats).getByText(value)).toBeTruthy()
  expect(within(stats).getByText('—')).toBeTruthy()
  expect(await within(inspector).findByRole('button', { name: 'Approve' })).toBeTruthy()
  fireEvent.click(within(inspector).getByRole('button', { name: 'Approve' }))
  expect(await within(inspector).findByText('You approved')).toBeTruthy()
  const decision = requests.find((request) => request.url.endsWith('/decision'))!
  expect(new Headers(decision.init?.headers).get('Idempotency-Key')).toBeTruthy()
})

test('filters the log by agent and tools, then refreshes streaming text from events and resets', async () => {
  setup()
  const log = await screen.findByRole('region', { name: 'Live log' })
  expect(await within(log).findByText('Reading api/events.py')).toBeTruthy()
  expect(within(log).getByRole('log').getAttribute('aria-live')).toBe('polite')
  const filters = within(log).getByRole('group', { name: 'Log filters' })
  fireEvent.click(within(filters).getByRole('button', { name: 'reviewer' }))
  await waitFor(() => expect(within(log).queryByText('Ran cursor tests, all passing')).toBeNull())
  expect(await within(log).findByText('Reading api/events.py')).toBeTruthy()
  fireEvent.click(within(filters).getByRole('button', { name: 'Tool calls' }))
  expect(await within(log).findByText('Ran cursor tests, all passing')).toBeTruthy()
  expect(within(log).queryByText('Reading api/events.py')).toBeNull()
  fireEvent.click(within(filters).getByRole('button', { name: 'Everyone' }))
  fixture.log.items.push({
    id: 'live',
    at: '2026-10-08T21:31:01.000Z',
    agentId: 'builder',
    kind: 'tool',
    text: 'New live tool result',
  })
  act(() =>
    Source.current.dispatchEvent(
      new MessageEvent('log.line', {
        data: JSON.stringify({
          seq: 2,
          ts: '2026-10-08T21:31:01.000Z',
          type: 'log.line',
          data: fixture.log.items.at(-1),
        }),
        lastEventId: '2',
      }),
    ),
  )
  expect(await within(log).findByText('New live tool result')).toBeTruthy()
  fixture.detail.model = 'Updated model'
  act(() =>
    Source.current.dispatchEvent(
      new MessageEvent('stream.reset', {
        data: JSON.stringify({
          type: 'stream.reset',
          ts: '2026-10-08T21:31:02.000Z',
          data: { reason: 'epoch' },
        }),
      }),
    ),
  )
  expect(await screen.findByText('Updated model')).toBeTruthy()
})

test('stops only the selected active step with an idempotency key and shows failures', async () => {
  stopStatus = 409
  setup()
  const inspector = await screen.findByRole('complementary', { name: 'Selected step' })
  await within(inspector).findByRole('heading', { name: 'Event stream' })
  fireEvent.click(within(inspector).getByRole('button', { name: 'Stop this step' }))
  expect(await within(inspector).findByRole('alert')).toHaveProperty(
    'textContent',
    'Nothing is running in this step',
  )
  const stop = requests.find((request) => request.url.endsWith('/stop'))!
  expect(stop.url).toBe('/api/flow/nodes/task%3Astream/stop')
  expect(stop.init?.method).toBe('POST')
  expect(new Headers(stop.init?.headers).get('Idempotency-Key')).toBeTruthy()
  stopStatus = 200
  fireEvent.click(within(inspector).getByRole('button', { name: 'Stop this step' }))
  expect(await within(inspector).findByRole('button', { name: 'Stopped' })).toHaveProperty(
    'disabled',
    true,
  )
})

test('shows the server message when Stop is unsupported for the run', async () => {
  stopStatus = 501
  setup()
  const inspector = await screen.findByRole('complementary', { name: 'Selected step' })
  await within(inspector).findByRole('heading', { name: 'Event stream' })
  fireEvent.click(within(inspector).getByRole('button', { name: 'Stop this step' }))
  expect((await within(inspector).findByRole('alert')).textContent).toBe(
    'Stop is not available for this run.',
  )
})

test('handles missing node details with a retry', async () => {
  nodeStatus = 404
  setup()
  const inspector = await screen.findByRole('complementary', { name: 'Selected step' })
  expect(await within(inspector).findByRole('alert')).toBeTruthy()
  nodeStatus = 200
  fireEvent.click(within(inspector).getByRole('button', { name: 'Try again' }))
  expect(await within(inspector).findByRole('heading', { name: 'Event stream' })).toBeTruthy()
})

test('a partial pause shows the server error and keeps a retry for the failed action', async () => {
  pauseFails = true
  setup()
  fireEvent.click(await screen.findByRole('button', { name: 'Pause run' }))
  expect((await screen.findByRole('alert')).textContent).toBe('1 task could not be held.')
  // The brief is now paused, yet the failed action stays retryable.
  await screen.findByText('Paused')
  expect(screen.getByRole('button', { name: 'Try pause again' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull()
})

test('continuous unrelated events do not cancel a slow flow read', async () => {
  flowDelayMs = 400
  setup()
  await screen.findByText('Loading the flow...')
  let seq = 10
  const deltas = setInterval(() => {
    Source.current.dispatchEvent(
      new MessageEvent('message.delta', {
        data: JSON.stringify({
          seq: ++seq,
          ts: '2026-10-08T21:31:01.000Z',
          type: 'message.delta',
          data: { messageId: 'other', roomId: 'room-other', append: 'x' },
        }),
        lastEventId: String(seq),
      }),
    )
  }, 50)
  try {
    await waitFor(() => expect(screen.queryByText('Loading the flow...')).toBeNull(), {
      timeout: 3000,
    })
  } finally {
    clearInterval(deltas)
  }
})

test('?node= selects that step when the flow opens', async () => {
  setup('/now/flow/fixture-flow?node=task%3Astates')
  await waitFor(() =>
    expect(requests.some((request) => request.url === '/api/flow/nodes/task%3Astates')).toBe(true),
  )
  expect(requests.some((request) => request.url === '/api/flow/nodes/task%3Astream')).toBe(false)
})

test('a step worked on by attempts lists them, reads tools as not observed and spend as partial', async () => {
  const attempt = (id: string, over: object = {}) => ({
    id,
    kind: 'kanban' as const,
    agentId: 'builder',
    role: 'implementer' as const,
    status: 'completed' as const,
    closureReason: null,
    startedAt: '2026-10-08T21:00:00.000Z',
    endedAt: '2026-10-08T21:10:00.000Z',
    observationEndedAt: null,
    evidence: 'proven' as const,
    taskId: 't1',
    task: { taskId: 't1', historyId: 'h', current: true },
    order: ['2026-10-08T21:00:00.000Z', 1] as [string, number],
    refusedUpdates: 0,
    tools: null,
    session: null,
    model: null,
    ...over,
  })
  fixture.detail = {
    ...fixture.detail,
    model: null,
    tools: null,
    attempts: [
      attempt('kr_1'),
      attempt('kr_2', {
        agentId: null,
        status: 'ended_unknown',
        endedAt: null,
        observationEndedAt: '2026-10-08T21:20:00.000Z',
        evidence: 'partial',
        task: { taskId: 't0', historyId: 'old', current: false },
      }),
    ],
  }
  fixture.flow.stats = { ...fixture.flow.stats, spendUsd: null, attempts: 2 }
  setup()
  const inspector = await screen.findByRole('complementary', { name: 'Selected step' })
  const attempts = await within(inspector).findByRole('region', { name: 'Attempts' })
  const rows = within(attempts).getAllByRole('listitem')
  expect(rows).toHaveLength(2)
  expect(rows[0]!.textContent).toContain('builder')
  expect(rows[1]!.textContent).toContain('Unattributed')
  expect(rows[1]!.textContent).toContain('no longer observed since')
  expect(rows[1]!.textContent).toContain('Provenance unknown')
  expect(within(rows[0]!).getByRole('link', { name: 'Completed' }).getAttribute('href')).toBe(
    '/tasks/t1',
  )
  expect(within(rows[1]!).getByRole('link', { name: 'Ended (unknown)' }).getAttribute('href')).toBe(
    '/attempts/kr_2',
  )
  expect(within(inspector).getAllByText('Not observed')).toHaveLength(2)
  const stats = screen.getByRole('region', { name: 'This run so far' })
  expect(within(stats).getByText('partial')).toBeTruthy()
})
