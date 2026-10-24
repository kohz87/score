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

vi.mock('../shell/use-needs-you.ts', () => ({ useNeedsYou: vi.fn(() => false) }))

class MockEventSource extends EventTarget {
  constructor(readonly url: string) {
    super()
  }
  close() {}
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
  expect(value('waiting-on-you')).toContain('median wait for your approval')
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

test('the classic view button stays at the bottom of the nav', async () => {
  const router = open('/b/settings/usage')
  await screen.findByRole('region', { name: 'Usage in numbers' })
  fireEvent.click(screen.getByRole('button', { name: 'Use the classic view' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/chat'))
  expect(window.localStorage.getItem('score.ui')).toBe('classic')
})
