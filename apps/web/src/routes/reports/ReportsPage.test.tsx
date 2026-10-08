import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Reports } from '@score/contract'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'

vi.mock('../../shell/use-needs-you.ts', () => ({ useNeedsYou: vi.fn(() => false) }))

class MockEventSource extends EventTarget {
  constructor(readonly url: string) {
    super()
  }
  close() {}
}
const agent = (
  id: string,
  name: string,
  color: string,
  shape: AgentSummary['style']['shape'],
  role = '',
) =>
  ({
    id,
    name,
    role,
    style: { color, shape },
    status: 'idle',
    activity: null,
    model: { id: 'm', label: 'M' },
    served: true,
  }) satisfies AgentSummary
const agents = [
  agent('builder', 'Builder', '#19c39a', 'triangle'),
  agent('reviewer', 'Reviewer', '#ffb61e', 'diamond', 'Reviews changes'),
]
const report = (range: Reports['range'], overrides: Partial<Reports> = {}): Reports => ({
  range,
  summary: `Summary for ${range}.`,
  totals: {
    tasksFinished: 38,
    runs: 112,
    firstPassRate: 0.71,
    medianTaskSec: 1440,
    spendUsd: 41.2,
  },
  byDay: [{ date: '2026-03-10', perAgent: { builder: 3, reviewer: 1 } }],
  timeSplit: [
    { agentId: 'builder', workingPct: 72, waitingOnYouPct: 9, waitingOnAgentPct: 19 },
    { agentId: 'reviewer', workingPct: 85, waitingOnYouPct: 0, waitingOnAgentPct: 15 },
  ],
  byAgent: [
    {
      agentId: 'builder',
      finished: 17,
      runs: 46,
      medianSec: 1860,
      firstPassRate: 0.65,
      spendUsd: 22.4,
    },
    {
      agentId: 'reviewer',
      finished: 8,
      runs: 24,
      medianSec: 540,
      firstPassRate: null,
      spendUsd: 9.3,
    },
  ],
  approvals: { asked: 24, approved: 21, denied: 3, medianWaitSec: 240, insight: 'Allow installs.' },
  ...overrides,
})
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let router: ReturnType<typeof createMemoryRouter>
let registry: ReturnType<typeof createStreamQueryRegistry>
let stream: ReturnType<typeof createStreamClient>
let calls: string[]
let respond: (path: string) => Response

beforeEach(() => {
  calls = []
  respond = (path) => {
    if (path === '/api/agents') return json({ asOfSeq: 0, items: agents })
    const range = new URL(path, 'http://x').searchParams.get('range') as Reports['range']
    if (path.startsWith('/api/reports')) return json(report(range))
    return json({ error: { code: 'not_found', message: 'No' } }, 404)
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      calls.push(path)
      return Promise.resolve(respond(path))
    }),
  )
})
function mount(url = '/reports') {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  stream = createStreamClient({ EventSourceImpl: MockEventSource, random: () => 0.5 })
  registry = createStreamQueryRegistry(queryClient, stream)
  router = createMemoryRouter(appRoutes, { initialEntries: [url] })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream, queries: registry }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}
afterEach(() => {
  cleanup()
  router.dispose()
  registry.dispose()
  stream.close()
  vi.unstubAllGlobals()
})

test('shows totals, the by-agent table, time split and approvals', async () => {
  mount()
  expect(await screen.findByText('Summary for 7d.')).toBeDefined()
  const totals = screen.getByRole('region', { name: 'In numbers' })
  expect(within(totals).getByText('38')).toBeDefined()
  expect(within(totals).getByText('71%')).toBeDefined()
  expect(within(totals).getByText('24 min')).toBeDefined()
  expect(within(totals).getByText('$41.20')).toBeDefined()

  const table = screen.getByRole('table', { name: 'By agent' })
  const rows = within(table).getAllByRole('row')
  expect(within(rows[1]!).getByText('31 min')).toBeDefined()
  expect(within(rows[1]!).getByText('65%')).toBeDefined()
  expect(within(rows[2]!).getByText('n/a, reviews')).toBeDefined()
  expect(within(rows[2]!).queryByLabelText('No reviewed tasks in this range')).toBeNull()
  expect(within(rows[2]!).getByText('$9.30')).toBeDefined()

  const split = screen.getByRole('img', {
    name: 'Builder: 72% working, 9% waiting on you, 19% waiting on another agent',
  })
  expect(split).toBeDefined()
  expect(screen.getByText('72% working')).toBeDefined()
  expect(screen.getByText('Waiting on another agent')).toBeDefined()

  const approvals = screen.getByRole('region', { name: 'Your approvals' })
  expect(within(approvals).getByText('21 approved')).toBeDefined()
  expect(within(approvals).getByText('3 denied')).toBeDefined()
  expect(within(approvals).getByText('4 min')).toBeDefined()
  expect(within(approvals).getByText('Allow installs.')).toBeDefined()
})

test('shows a dash for unknown values', async () => {
  respond = (path) =>
    path === '/api/agents'
      ? json({ asOfSeq: 0, items: agents })
      : json(
          report('7d', {
            totals: {
              tasksFinished: 0,
              runs: 0,
              firstPassRate: null,
              medianTaskSec: null,
              spendUsd: null,
            },
            byAgent: [
              {
                agentId: 'builder',
                finished: 0,
                runs: 0,
                medianSec: null,
                firstPassRate: null,
                spendUsd: null,
              },
            ],
            approvals: { asked: 0, approved: 0, denied: 0, medianWaitSec: null, insight: null },
          }),
        )
  mount()
  const totals = await screen.findByRole('region', { name: 'In numbers' })
  expect(within(totals).getAllByText('—')).toHaveLength(3)
  const approvals = screen.getByRole('region', { name: 'Your approvals' })
  expect(within(approvals).getByText('—')).toBeDefined()
  const row = within(screen.getByRole('table', { name: 'By agent' })).getAllByRole('row')[1]!
  expect(within(row).getAllByText('—')).toHaveLength(3)
  expect(within(row).getByLabelText('No reviewed tasks in this range')).toBeDefined()
  expect(within(row).queryByText('n/a, reviews')).toBeNull()
})

test('range tabs refetch, update the URL and the CSV link', async () => {
  mount()
  await screen.findByText('Summary for 7d.')
  expect(screen.getByRole('button', { name: '7 days' }).getAttribute('aria-pressed')).toBe('true')
  const zone = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)
  // Days are the viewer's: the browser's time zone goes with every Reports request.
  expect(screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href')).toBe(
    `/api/reports/export.csv?range=7d&tz=${zone}`,
  )
  fireEvent.click(screen.getByRole('button', { name: '30 days' }))
  expect(await screen.findByText('Summary for 30d.')).toBeDefined()
  expect(router.state.location.search).toBe('?range=30d')
  expect(calls).toContain(`/api/reports?range=30d&tz=${zone}`)
  expect(screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href')).toBe(
    `/api/reports/export.csv?range=30d&tz=${zone}`,
  )
})

test('reads the range from the URL and falls back to 7 days', async () => {
  mount('/reports?range=today')
  expect(await screen.findByText('Summary for today.')).toBeDefined()
  cleanup()
  router.dispose()
  registry.dispose()
  stream.close()
  mount('/reports?range=bogus')
  await waitFor(() => expect(screen.getByText('Summary for 7d.')).toBeDefined())
})

test('shows an error with a retry when the report fails', async () => {
  respond = (path) =>
    path === '/api/agents'
      ? json({ asOfSeq: 0, items: agents })
      : json({ error: { code: 'internal', message: 'Boom' } }, 500)
  mount()
  expect(await screen.findByRole('alert')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined()
})
