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
    cacheHitRate: null,
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
      cacheHitRate: null,
    },
    {
      agentId: 'reviewer',
      finished: 8,
      runs: 24,
      medianSec: 540,
      firstPassRate: null,
      spendUsd: 9.3,
      cacheHitRate: null,
    },
  ],
  trend: [],
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
              cacheHitRate: null,
            },
            byAgent: [
              {
                agentId: 'builder',
                finished: 0,
                runs: 0,
                medianSec: null,
                firstPassRate: null,
                spendUsd: null,
                cacheHitRate: null,
              },
            ],
            approvals: { asked: 0, approved: 0, denied: 0, medianWaitSec: null, insight: null },
          }),
        )
  mount()
  const totals = await screen.findByRole('region', { name: 'In numbers' })
  expect(within(totals).getAllByText('—')).toHaveLength(4)
  const approvals = screen.getByRole('region', { name: 'Your approvals' })
  expect(within(approvals).getByText('—')).toBeDefined()
  const row = within(screen.getByRole('table', { name: 'By agent' })).getAllByRole('row')[1]!
  expect(within(row).getAllByText('—')).toHaveLength(4)
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

test('prefetches the other presets once the first report is up', async () => {
  mount()
  await screen.findByText('Summary for 7d.')
  await waitFor(() => {
    expect(calls.some((c) => c.startsWith('/api/reports?range=today'))).toBe(true)
    expect(calls.some((c) => c.startsWith('/api/reports?range=30d'))).toBe(true)
  })
  // The prefetched range answers from cache at once.
  fireEvent.click(screen.getByRole('button', { name: '30 days' }))
  expect(await screen.findByText('Summary for 30d.')).toBeDefined()
})

test('a range switch shows a spinner, dims the old figures and marks the page busy', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      calls.push(path)
      // Only the 30 day request is slow; the prefetch of it is held back too.
      if (path.startsWith('/api/reports?range=30d')) await gate
      return respond(path)
    }),
  )
  mount()
  await screen.findByText('Summary for 7d.')
  fireEvent.click(screen.getByRole('button', { name: '30 days' }))
  const chip = screen.getByRole('button', { name: '30 days' })
  await waitFor(() => expect(chip.querySelector('.reports-spinner')).not.toBeNull())
  const body = document.querySelector('.reports-body')!
  expect(body.getAttribute('aria-busy')).toBe('true')
  // The previous numbers stay up, dimmed.
  expect(screen.getByText('Summary for 7d.')).toBeDefined()
  expect(body.classList.contains('reports-body--stale')).toBe(true)
  release()
  expect(await screen.findByText('Summary for 30d.')).toBeDefined()
  await waitFor(() => expect(chip.querySelector('.reports-spinner')).toBeNull())
  expect(body.getAttribute('aria-busy')).toBe('false')
})

test('a custom range is chosen in a popover, validated, shown in the chip and kept in the URL', async () => {
  mount()
  await screen.findByText('Summary for 7d.')
  fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
  const dialog = screen.getByRole('dialog', { name: 'Custom range' })
  const from = within(dialog).getByLabelText('From') as HTMLInputElement
  const to = within(dialog).getByLabelText('To') as HTMLInputElement
  const apply = within(dialog).getByRole('button', { name: 'Apply' }) as HTMLButtonElement
  const today = to.max
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(from.max).toBe(today)

  fireEvent.change(from, { target: { value: '2020-01-01' } })
  expect(apply.disabled).toBe(true)
  expect(within(dialog).getByRole('status').textContent).toMatch(/at most 366/)
  fireEvent.change(from, { target: { value: '2020-01-10' } })
  fireEvent.change(to, { target: { value: '2020-01-05' } })
  expect(apply.disabled).toBe(true)
  expect(within(dialog).getByRole('status').textContent).toMatch(/must not be after/)
  fireEvent.change(to, { target: { value: today } })
  fireEvent.change(from, { target: { value: today } })
  expect(apply.disabled).toBe(false)

  // Something in the current year, so the chip has no year.
  const year = today.slice(0, 4)
  fireEvent.change(from, { target: { value: `${year}-01-03` } })
  fireEvent.change(to, { target: { value: `${year}-01-09` } })
  fireEvent.click(apply)

  expect(await screen.findByText('Summary for custom.')).toBeDefined()
  expect(router.state.location.search).toBe(`?range=custom&from=${year}-01-03&to=${year}-01-09`)
  expect(screen.getByRole('button', { name: '3 Jan – 9 Jan' }).getAttribute('aria-pressed')).toBe(
    'true',
  )
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href')).toContain(
    `range=custom&from=${year}-01-03&to=${year}-01-09`,
  )
  expect(calls.some((c) => c.includes(`range=custom&from=${year}-01-03&to=${year}-01-09`))).toBe(
    true,
  )
})

test('a custom range in the URL survives a reload, and a bad one falls back to 7 days', async () => {
  mount('/reports?range=custom&from=2025-01-03&to=2025-01-09')
  expect(await screen.findByText('Summary for custom.')).toBeDefined()
  expect(screen.getByRole('button', { name: '3 Jan 2025 – 9 Jan 2025' })).toBeDefined()
  cleanup()
  router.dispose()
  registry.dispose()
  stream.close()
  mount('/reports?range=custom&from=2025-02-03&to=2025-01-09')
  expect(await screen.findByText('Summary for 7d.')).toBeDefined()
})

test('cache hit rate, the 30-day trend and the display currency toggle', async () => {
  localStorage.removeItem('score.reports.currency')
  respond = (path) => {
    if (path === '/api/agents') return json({ asOfSeq: 0, items: agents })
    if (path === '/api/settings/currency') return json({ code: 'EUR', rate: 0.5 })
    const base = report('7d')
    return json({
      ...base,
      totals: { ...base.totals, cacheHitRate: 0.64 },
      byAgent: base.byAgent.map((row, index) => ({
        ...row,
        cacheHitRate: index === 0 ? 0.8 : null,
      })),
      trend: [
        { date: '2026-03-09', runs: 3, spendUsd: 2 },
        { date: '2026-03-10', runs: 5, spendUsd: null },
      ],
    })
  }
  mount()
  const totals = await screen.findByRole('region', { name: 'In numbers' })
  expect(within(totals).getByText('64%')).toBeDefined()
  const rows = within(screen.getByRole('table', { name: 'By agent' })).getAllByRole('row')
  expect(within(rows[1]!).getByText('80%')).toBeDefined()
  expect(within(rows[2]!).getByLabelText('Hermes gave no cache figures')).toBeDefined()

  const trend = screen.getByRole('table', { name: /Runs and spend per day/ })
  expect(within(trend).getByText('2026-03-10')).toBeDefined()
  expect(within(trend).getByText('$2.00')).toBeDefined()
  expect(screen.getByRole('img', { name: /Last 2 days: 8 runs, \$2\.00 spend/ })).toBeDefined()

  // USD until the person switches; the typed rate then converts every money value.
  expect(within(totals).getByText('$41.20')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'EUR' }))
  expect(within(totals).getByText('€20.60')).toBeDefined()
  expect(within(trend).getByText('€1.00')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'USD' }))
  expect(within(totals).getByText('$41.20')).toBeDefined()
  localStorage.removeItem('score.reports.currency')
})

test('a malformed custom date is a message, never an exception', async () => {
  const { customRangeError } = await import('./reports-queries.ts')
  expect(customRangeError('2026-13-01', '2026-13-02', '2026-10-09')).toBe('Pick both days.')
  expect(customRangeError('2026-02-30', '2026-03-01', '2026-10-09')).toBe('Pick both days.')
})

test('an Unattributed row counts attempts with no known agent and says what its time counts', async () => {
  respond = (path) =>
    path === '/api/agents'
      ? json({ asOfSeq: 0, items: agents })
      : json(report('7d', { unattributed: { runs: 3, workingSec: 600 } }))
  mount()
  const table = await screen.findByRole('table', { name: 'By agent' })
  const rows = within(table).getAllByRole('row')
  const last = rows.at(-1)!
  expect(within(last).getByText('Unattributed')).toBeDefined()
  expect(within(last).getByText('3')).toBeDefined()
  expect(screen.getByText(/counts attempts with proven evidence only/)).toBeDefined()
  expect(screen.getByText(/10 min/)).toBeDefined()
})

test('without attempts there is no Unattributed row', async () => {
  mount()
  const table = await screen.findByRole('table', { name: 'By agent' })
  expect(within(table).queryByText('Unattributed')).toBeNull()
})

const journey = {
  from: '2026-03-04',
  to: '2026-03-10',
  truncated: false,
  agents: [
    {
      id: 'builder',
      events: [
        { at: '2026-03-09T10:00:00.000Z', kind: 'task_done', label: 'Fix the feed', ref: 't1' },
        {
          at: '2026-03-08T10:00:00.000Z',
          kind: 'memory_changed',
          label: 'Memory file changed',
          ref: null,
        },
        { at: '2026-03-07T10:00:00.000Z', kind: 'skill_changed', label: 'code-review', ref: null },
      ],
    },
    {
      id: 'reviewer',
      events: [
        {
          at: '2026-03-06T10:00:00.000Z',
          kind: 'note_written',
          label: 'Release retro',
          ref: 'retro.md',
        },
      ],
    },
  ],
}

test('the Journey tab draws one row per agent with a legend and a text alternative', async () => {
  respond = (path) =>
    path === '/api/agents'
      ? json({ asOfSeq: 0, items: agents })
      : path.startsWith('/api/reports/journey')
        ? json(journey)
        : json(report('7d'))
  mount()
  await screen.findByText('Summary for 7d.')
  fireEvent.click(screen.getByRole('button', { name: 'Journey' }))
  expect(router.state.location.search).toContain('tab=journey')
  const chart = await screen.findByRole('img', {
    name: /Journey from 2026-03-04 to 2026-03-10: 4 marks/,
  })
  expect(chart).toBeDefined()
  expect(screen.queryByRole('table', { name: 'By agent' })).toBeNull()
  const legend = screen.getByRole('list', { name: 'Legend' })
  for (const label of [
    'Task completed',
    'Knowledge note written',
    'Skill changed',
    'Memory file changed',
  ])
    expect(within(legend).getByText(label)).toBeDefined()
  const counts = screen.getByRole('table', { name: 'Journey counts per agent' })
  const rows = within(counts).getAllByRole('row')
  expect(
    within(rows[1]!)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ).toEqual(['1', '0', '1', '1'])
  expect(
    within(rows[2]!)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ).toEqual(['0', '1', '0', '0'])
  // Memory is a mark with no content, and the list says so.
  const list = screen.getByText('All marks as a list').closest('details')!
  expect(list.textContent).toContain('Skill changed, code-review')
  expect(list.textContent).not.toContain('Memory file changed, ')
  expect(calls.some((c) => c.startsWith('/api/reports/journey?from=') && c.includes('&to='))).toBe(
    true,
  )
})
