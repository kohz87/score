import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App, appRoutes } from '../App.tsx'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { immediateFrameScheduler, createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { stubReducedMotion } from '../motion/test-support.ts'
import { jsonResponse, reportAgents, reportFixture } from '../test/reports-fixtures.ts'

class MockEventSource extends EventTarget {
  constructor(readonly url: string) {
    super()
  }
  close() {}
}

const journeyFixture = {
  from: '2026-03-04',
  to: '2026-03-10',
  truncated: false,
  agents: [
    {
      id: 'builder',
      events: [
        { at: '2026-03-09T10:00:00.000Z', kind: 'task_done', label: 'Fix the feed', ref: 't1' },
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
          ref: 'r.md',
        },
      ],
    },
  ],
}

let router: ReturnType<typeof createMemoryRouter>
let registry: ReturnType<typeof createStreamQueryRegistry>
let stream: ReturnType<typeof createStreamClient>
let calls: string[]
let reportForRange: typeof reportFixture

beforeEach(() => {
  stubReducedMotion()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  calls = []
  reportForRange = reportFixture
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      calls.push(`${url.pathname}${url.search}`)
      if (url.pathname === '/api/agents')
        return Promise.resolve(jsonResponse({ asOfSeq: 0, items: reportAgents }))
      if (url.pathname === '/api/reports') {
        const range = (url.searchParams.get('range') ?? '7d') as 'today' | '7d' | '30d' | 'custom'
        return Promise.resolve(jsonResponse(reportForRange(range)))
      }
      if (url.pathname === '/api/reports/journey')
        return Promise.resolve(jsonResponse(journeyFixture))
      return Promise.resolve(jsonResponse({ error: { code: 'not_found', message: 'No' } }, 404))
    }),
  )
})

afterEach(() => {
  cleanup()
  router.dispose()
  registry.dispose()
  stream.close()
  vi.unstubAllGlobals()
})

function open(path = '/b/settings') {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  stream = createStreamClient({ EventSourceImpl: MockEventSource as never })
  registry = createStreamQueryRegistry(queryClient, stream, immediateFrameScheduler)
  router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream, queries: registry }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
  return router
}

test('the prototype Settings nav has nine sections, opens Usage and selects a section', async () => {
  const router = open('/b/settings')
  expect(await screen.findByRole('heading', { name: 'Usage' })).toBeDefined()
  const nav = screen.getByRole('navigation', { name: 'Settings' })
  const labels = [
    'Connections',
    'Tools and triggers',
    'Rules',
    'Notifications',
    'Look',
    'Usage',
    'Remote access and security',
    'Advanced',
    'System',
  ]
  for (const label of labels) {
    expect(within(nav).getByRole('button', { name: new RegExp(`^${label}`) })).toBeDefined()
  }
  expect(
    within(nav)
      .getByRole('button', { name: /^Usage/ })
      .getAttribute('aria-current'),
  ).toBe('page')

  fireEvent.click(within(nav).getByRole('button', { name: /^Connections/ }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/settings/connections'))
  expect(await screen.findByRole('heading', { name: 'Connections' })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Hermes' })).toBeDefined()
  expect(
    within(nav)
      .getByRole('button', { name: /^Connections/ })
      .getAttribute('aria-current'),
  ).toBe('page')

  fireEvent.click(within(nav).getByRole('button', { name: /^Rules/ }))
  expect(await screen.findByRole('heading', { name: 'Rules' })).toBeDefined()
})

test('every headline number equals the Reports API fixture and approvals stay folded in', async () => {
  open('/b/settings/usage')
  const numbers = await screen.findByRole('region', { name: 'Usage in numbers' })
  const value = (stat: string) =>
    numbers.querySelector<HTMLElement>(`[data-stat="${stat}"]`)?.textContent ?? ''
  expect(value('jobs-done')).toContain('38')
  expect(value('first-pass')).toContain('71%')
  expect(value('waiting-on-you')).toContain('4 min')
  expect(value('waiting-on-you')).toContain('24 approvals answered')
  expect(screen.getByRole('link', { name: 'Review rules' }).getAttribute('href')).toBe(
    '/b/settings/rules',
  )
  expect(value('spend')).toContain('$41.20')
  expect(screen.queryByRole('region', { name: 'Your approvals' })).toBeNull()
})

test('jobs per day is one neutral series with the busiest day highlighted and an agent table', async () => {
  reportForRange = (range) =>
    reportFixture(range, {
      byDay: [
        { date: '2026-03-09', perAgent: { builder: 2, reviewer: 1 } },
        { date: '2026-03-10', perAgent: { builder: 3, reviewer: 1 } },
        { date: '2026-03-11', perAgent: { builder: 5, reviewer: 2 } },
      ],
    })
  open('/b/settings/usage')
  const card = await screen.findByRole('region', { name: 'Jobs done per day' })
  const columns = [...card.querySelectorAll<HTMLElement>('.usage-jobs-column')]
  expect(columns.map((column) => column.dataset.total)).toEqual(['3', '4', '7'])
  expect(card.querySelectorAll('[data-part="bar"]')).toHaveLength(3)
  expect(card.querySelector('.usage-jobs-bar--busiest')?.parentElement?.dataset.day).toBe(
    '2026-03-11',
  )
  expect(card.querySelector('.usage-jobs-value')?.textContent).toBe('7')
  expect([...card.querySelectorAll('.usage-jobs-label')].map((label) => label.textContent)).toEqual(
    ['Mon', 'Tue', 'Wed'],
  )
  expect(within(card).queryByRole('list', { name: 'Agents' })).toBeNull()

  const table = within(card).getByRole('table', { name: 'Jobs done per day, by agent' })
  expect(table.className).toContain('usage-sr-only')
  fireEvent.click(within(card).getByRole('button', { name: 'Show as table' }))
  expect(table.className).toContain('usage-table')
  expect(within(card).getByRole('button', { name: 'Hide table' })).toBeDefined()
  expect([...table.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual([
    'Day',
    'Jobs done',
    'Builder',
    'Reviewer',
  ])
  const rows = within(table).getAllByRole('row')
  expect([...rows[1]!.querySelectorAll('th, td')].map((cell) => cell.textContent)).toEqual([
    '2026-03-09',
    '3',
    '2',
    '1',
  ])
})

test('spend by agent sorts highest first and keeps each agent glyph', async () => {
  reportForRange = (range) => {
    const fixture = reportFixture(range)
    return reportFixture(range, { byAgent: [...fixture.byAgent].reverse() })
  }
  open('/b/settings/usage')
  const card = await screen.findByRole('region', { name: 'Spend by agent' })
  expect(
    [...card.querySelectorAll('.usage-spend-name')].map((name) => name.textContent?.trim()),
  ).toEqual(['Builder', 'Reviewer'])
  const glyphs = [...card.querySelectorAll<SVGSVGElement>('.usage-spend-name svg')]
  expect(glyphs).toHaveLength(2)
  expect(glyphs[0]!.style.getPropertyValue('--glyph-color')).toBe('#14A985')
  expect(glyphs[1]!.style.getPropertyValue('--glyph-color')).toBe('#C08A10')
  expect(
    [...card.querySelectorAll('.usage-spend-value')].map((value) => value.textContent),
  ).toEqual(['$22.40', '$9.30'])
  const table = within(card).getByRole('table', { name: 'Spend by agent' })
  expect(table.className).toContain('usage-sr-only')
  fireEvent.click(within(card).getByRole('button', { name: 'Show as table' }))
  expect(table.className).toContain('usage-table')
  const rows = within(table).getAllByRole('row')
  expect(rows[1]!.textContent).toContain('Builder')
  expect(rows[1]!.textContent).toContain('$22.40')
  expect(rows[2]!.textContent).toContain('Reviewer')
  expect(rows[2]!.textContent).toContain('$9.30')
})

test('3.10.0: speed by agent shows medians and a dash where nothing was measured', async () => {
  reportForRange = (range) =>
    reportFixture(range, {
      speedByAgent: [
        { agentId: 'builder', runs: 7, medianTtftMs: 1200, medianTokensPerSecond: 48.2 },
      ],
    })
  open('/b/settings/usage')
  const card = await screen.findByRole('region', { name: 'Speed by agent' })
  const rows = within(within(card).getByRole('table', { name: 'Speed by agent' })).getAllByRole(
    'row',
  )
  const cells = (row: HTMLElement) =>
    [...row.querySelectorAll('th, td')].map((cell) => cell.textContent)
  expect(cells(rows[1]!)).toEqual(['Builder', '1.2 s', '48 tok/s', '7'])
  expect(cells(rows[2]!)).toEqual(['Reviewer', '—', '—', '0'])
})

test('a coding agent’s estimated or unknown spend is marked beside the figure', async () => {
  reportForRange = (range) => {
    const fixture = reportFixture(range)
    const [builder, reviewer] = fixture.byAgent
    return reportFixture(range, {
      byAgent: [
        { ...builder!, spendBasis: 'estimated' },
        { ...reviewer!, spendUsd: null, spendBasis: 'unknown' },
      ],
    })
  }
  open('/b/settings/usage')
  const card = await screen.findByRole('region', { name: 'Spend by agent' })
  expect(
    [...card.querySelectorAll('.usage-spend-value')].map((value) => value.textContent),
  ).toEqual(['$22.40 estimated', 'unknown'])
  const rows = within(within(card).getByRole('table', { name: 'Spend by agent' })).getAllByRole(
    'row',
  )
  expect(rows[1]!.textContent).toContain('$22.40 estimated')
  expect(rows[2]!.textContent).toContain('unknown')
})

test('a removed agent with nothing spent is left out; one that spent stays (3.7.13)', async () => {
  reportForRange = (range) => {
    const fixture = reportFixture(range)
    const [builder] = fixture.byAgent
    return reportFixture(range, {
      byAgent: [
        ...fixture.byAgent,
        { ...builder!, agentId: 'gone-quiet', spendUsd: null },
        { ...builder!, agentId: 'gone-spent', spendUsd: 1.5 },
      ],
    })
  }
  open('/b/settings/usage')
  const card = await screen.findByRole('region', { name: 'Spend by agent' })
  const names = [...card.querySelectorAll('.usage-spend-name')].map((name) =>
    name.textContent?.trim(),
  )
  expect(names).toContain('gone-spent')
  expect(names).not.toContain('gone-quiet')
})

test('range switching refetches and the CSV link carries the same range', async () => {
  const router = open('/b/settings/usage')
  await screen.findByRole('region', { name: 'Usage in numbers' })
  const link = screen.getByRole('link', { name: 'Download CSV' })
  expect(link.getAttribute('href')).toContain('range=7d')
  expect(link.getAttribute('href')).toContain('tz=')

  const before = calls.filter((call) => call.includes('range=30d')).length
  fireEvent.click(screen.getByRole('button', { name: '30 days' }))
  await waitFor(() =>
    expect(calls.filter((call) => call.includes('range=30d')).length).toBeGreaterThan(before),
  )
  expect(router.state.location.search).toContain('range=30d')
  expect(screen.getByRole('button', { name: '30 days' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('link', { name: 'Download CSV' }).getAttribute('href')).toContain(
    'range=30d',
  )
})

test('the Journey view draws one row per agent with a legend and a count table', async () => {
  const router = open('/b/settings/usage')
  await screen.findByRole('region', { name: 'Usage in numbers' })
  fireEvent.click(screen.getByRole('button', { name: 'Journey' }))
  expect(router.state.location.search).toContain('tab=journey')
  expect(
    await screen.findByRole('img', { name: /Journey from 2026-03-04 to 2026-03-10: 3 marks/ }),
  ).toBeDefined()
  expect(screen.queryByRole('region', { name: 'Usage in numbers' })).toBeNull()
  expect(
    within(screen.getByRole('list', { name: 'Legend' })).getByText('Skill changed'),
  ).toBeDefined()
  expect(screen.getByRole('table', { name: 'Journey counts per agent' })).toBeDefined()
  expect(calls.some((c) => c.startsWith('/api/reports/journey?from='))).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Overview' }))
  expect(await screen.findByRole('region', { name: 'Usage in numbers' })).toBeDefined()
})

test('Custom range asks for the days, refetches them and the CSV link follows', async () => {
  const router = open('/b/settings/usage')
  await screen.findByRole('region', { name: 'Usage in numbers' })
  fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
  const form = screen.getByRole('form', { name: 'Custom range' })
  fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-02-01' } })
  fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-02-10' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Apply' }))
  await waitFor(() =>
    expect(calls.some((c) => c.includes('range=custom&from=2026-02-01&to=2026-02-10'))).toBe(true),
  )
  expect(router.state.location.search).toContain('range=custom')
  expect(screen.getByRole('link', { name: 'Download CSV' }).getAttribute('href')).toMatch(
    /range=custom&from=2026-02-01&to=2026-02-10/,
  )
})

test('Custom range refuses a first day after the last day', async () => {
  open('/b/settings/usage')
  await screen.findByRole('region', { name: 'Usage in numbers' })
  fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
  const form = screen.getByRole('form', { name: 'Custom range' })
  fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-02-10' } })
  fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-02-01' } })
  expect(within(form).getByRole('status').textContent).toMatch(/must not be after/)
  expect((within(form).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
})

test('the By agent table lists each agent with its figures', async () => {
  open('/b/settings/usage')
  const table = await screen.findByRole('table', { name: /^By agent$/ })
  const headers = within(table)
    .getAllByRole('columnheader')
    .map((cell) => cell.textContent)
  expect(headers).toEqual([
    'Agent',
    'Jobs done',
    'Runs',
    'Median time',
    'First-time pass',
    'Cache hits',
    'Spend',
  ])
  expect(within(table).getAllByRole('row').length).toBeGreaterThan(1)
  expect(within(table).getAllByText('Builder').length).toBeGreaterThan(0)
})

test('a reviewer with no first-time figure reads "n/a, reviews"', async () => {
  open('/b/settings/usage')
  const table = await screen.findByRole('table', { name: /^By agent$/ })
  const row = within(table)
    .getByRole('rowheader', { name: /Reviewer/ })
    .closest('tr')!
  expect(row.textContent).toContain('n/a, reviews')
})

test('the By agent table has an Unknown agent row for unattributed runs', async () => {
  reportForRange = (range) => ({
    ...reportFixture(range),
    unattributed: { runs: 4, workingSec: 120 },
  })
  open('/b/settings/usage')
  const table = await screen.findByRole('table', { name: /^By agent$/ })
  const row = within(table).getByRole('rowheader', { name: 'Unknown agent' }).closest('tr')!
  expect(within(row).getAllByRole('cell')[1]!.textContent).toBe('4')
})

test('the By agent table says it is loading before the report arrives', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      if (url.pathname === '/api/agents')
        return Promise.resolve(jsonResponse({ asOfSeq: 0, items: reportAgents }))
      return new Promise(() => {})
    }),
  )
  open('/b/settings/usage')
  expect(await screen.findByText('Loading the table…')).toBeDefined()
  expect(screen.queryByText('No agents yet.')).toBeNull()
})

test('the custom form follows a preset picked while it is open', async () => {
  open('/b/settings/usage')
  await screen.findByRole('region', { name: 'Usage in numbers' })
  fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
  const form = screen.getByRole('form', { name: 'Custom range' })
  fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-02-01' } })
  fireEvent.change(within(form).getByLabelText('To'), { target: { value: '2026-02-10' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Apply' }))
  await waitFor(() => expect(calls.some((c) => c.includes('range=custom'))).toBe(true))
  fireEvent.click(screen.getByRole('button', { name: '30 days' }))
  await waitFor(() =>
    expect(
      (
        within(screen.getByRole('form', { name: 'Custom range' })).getByLabelText(
          'From',
        ) as HTMLInputElement
      ).value,
    ).not.toBe('2026-02-01'),
  )
})
