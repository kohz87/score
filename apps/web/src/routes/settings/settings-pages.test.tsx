import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'

// PLAN 10.1: Settings is one page per section; the old /settings#<id> anchors redirect.

vi.mock('../../shell/use-needs-you.ts', () => ({ useNeedsYou: vi.fn(() => false) }))

class MockEventSource extends EventTarget {
  constructor(readonly url: string) {
    super()
  }
  close() {}
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let router: ReturnType<typeof createMemoryRouter>
let registry: ReturnType<typeof createStreamQueryRegistry>
let stream: ReturnType<typeof createStreamClient>
let terminalOn = false
let narrow = false

const titles = [
  ['models', 'Models and keys', 'Models and keys'],
  ['connections', 'Connections', 'Connections'],
  ['rules', 'Rules and approvals', 'Rules and approvals'],
  ['look', 'Look', 'Look'],
  ['notifications', 'Notifications', 'Notifications'],
  ['knowledge', 'Knowledge', 'Knowledge'],
  ['shares', 'Shares', 'Shares'],
  ['advanced', 'Advanced', 'Advanced'],
  ['backup', 'Backup', 'Backup and restore'],
  ['logs', 'Logs', 'Logs'],
  ['about', 'About', 'About Score'],
] as const

beforeEach(() => {
  terminalOn = false
  narrow = false
  window.scrollTo = vi.fn()
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: narrow && query.includes('1024'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      if (path === '/api/agents') return Promise.resolve(json({ asOfSeq: 0, items: [] }))
      if (path === '/api/session/security')
        return Promise.resolve(
          json({
            passwordSet: false,
            terminal: terminalOn,
            terminalUnavailable: null,
          }),
        )
      return Promise.resolve(json({ error: { code: 'not_found', message: 'No' } }, 404))
    }),
  )
})
afterEach(() => {
  cleanup()
  router.dispose()
  registry.dispose()
  stream.close()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-score-transport')
})

function mount(path: string) {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  stream = createStreamClient({ EventSourceImpl: MockEventSource, random: () => 0.5 })
  registry = createStreamQueryRegistry(queryClient, stream)
  router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream, queries: registry }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}
const nav = () => within(screen.getByRole('navigation', { name: 'Settings sections' }))
const here = () => router.state.location.pathname + router.state.location.search

test('/settings opens the first section, replacing the entry', async () => {
  mount('/settings')
  await waitFor(() => expect(here()).toBe('/settings/models'))
  expect(router.state.historyAction).toBe('REPLACE')
  expect(await screen.findByRole('region', { name: 'Models and keys' })).toBeDefined()
})

test.each(titles)(
  '/settings/%s shows only that section, with its link marked as the current page',
  async (id, label, heading) => {
    mount(`/settings/${id}`)
    await screen.findByRole('heading', { level: 2, name: heading })
    expect(nav().getByRole('link', { name: label }).getAttribute('aria-current')).toBe('page')
    expect(
      nav()
        .getAllByRole('link')
        .filter((link) => link.hasAttribute('aria-current')),
    ).toHaveLength(1)
    // The other sections' headings are not on the page.
    const others = titles.filter(([other]) => other !== id)
    for (const [, , otherHeading] of others)
      expect(screen.queryByRole('heading', { level: 2, name: otherHeading })).toBeNull()
    expect(document.title).toBe(`${label} · Settings · Score`)
  },
)

test('old /settings#<id> links redirect to the page and keep the query', async () => {
  mount('/settings#look')
  await waitFor(() => expect(here()).toBe('/settings/look'))
  expect(await screen.findByRole('region', { name: 'Look' })).toBeDefined()
  cleanup()
  router.dispose()
  mount('/settings?look=safe#rules')
  await waitFor(() => expect(here()).toBe('/settings/rules?look=safe'))
  expect(router.state.location.hash).toBe('')
})

test('an unknown section, and an unknown anchor, show the first one', async () => {
  mount('/settings/nope')
  await waitFor(() => expect(here()).toBe('/settings/models'))
  cleanup()
  router.dispose()
  mount('/settings#nope')
  await waitFor(() => expect(here()).toBe('/settings/models'))
})

test('Remote access is a section only on the remote transport', async () => {
  mount('/settings/remote-access')
  await waitFor(() => expect(here()).toBe('/settings/models'))
  expect(nav().queryByRole('link', { name: 'Remote access' })).toBeNull()
  cleanup()
  router.dispose()
  document.documentElement.setAttribute('data-score-transport', 'tls')
  mount('/settings#remote-access')
  await waitFor(() => expect(here()).toBe('/settings/remote-access'))
  expect(nav().getByRole('link', { name: 'Remote access' }).getAttribute('aria-current')).toBe(
    'page',
  )
  expect(await screen.findByRole('region', { name: 'Remote access' })).toBeDefined()
})

test('Terminal is a section only while the web terminal is on; a deep link waits for the answer', async () => {
  mount('/settings/terminal')
  await waitFor(() => expect(here()).toBe('/settings/models'))
  expect(nav().queryByRole('link', { name: 'Terminal' })).toBeNull()
  cleanup()
  router.dispose()
  terminalOn = true
  mount('/settings/terminal')
  expect(await screen.findByRole('region', { name: 'Terminal' })).toBeDefined()
  expect(here()).toBe('/settings/terminal')
})

test('clicking a section navigates, scrolls to the top and moves focus to its heading; back and forward work', async () => {
  mount('/settings/models')
  await screen.findByRole('region', { name: 'Models and keys' })
  fireEvent.click(nav().getByRole('link', { name: 'Logs' }))
  const heading = await screen.findByRole('heading', { level: 2, name: 'Logs' })
  expect(here()).toBe('/settings/logs')
  await waitFor(() => expect(document.activeElement).toBe(heading))
  expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
  await act(async () => {
    await router.navigate(-1)
  })
  expect(here()).toBe('/settings/models')
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'Models and keys' }),
    ),
  )
  await act(async () => {
    await router.navigate(1)
  })
  expect(here()).toBe('/settings/logs')
  expect(document.title).toBe('Logs · Settings · Score')
})

test('the first load does not take focus', async () => {
  mount('/settings/about')
  await screen.findByRole('heading', { level: 2, name: 'About Score' })
  expect(document.activeElement).toBe(document.body)
})

test('on a phone the Section picker names the current section and navigates', async () => {
  narrow = true
  mount('/settings/connections')
  const picker = await screen.findByRole('button', { name: /Section\s*Connections/ })
  expect(screen.queryByRole('link', { name: 'Logs' })).toBeNull()
  fireEvent.click(picker)
  const list = document.getElementById('settings-jump-list')!
  expect(within(list).getByRole('link', { name: 'Connections' }).getAttribute('aria-current')).toBe(
    'page',
  )
  fireEvent.click(within(list).getByRole('link', { name: 'Logs' }))
  expect(await screen.findByRole('heading', { level: 2, name: 'Logs' })).toBeDefined()
  expect(here()).toBe('/settings/logs')
  expect(screen.getByRole('button', { name: /Section\s*Logs/ }).getAttribute('aria-expanded')).toBe(
    'false',
  )
})

test('the Hermes banner and the Team note show above every section', async () => {
  mount('/settings/logs')
  await screen.findByRole('heading', { level: 2, name: 'Logs' })
  expect(screen.getByText(/Settings for one agent are on that agent’s page in Team/)).toBeDefined()
})

test('the palette finds each Settings section once something is typed, and opens it', async () => {
  mount('/now')
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  const palette = await screen.findByRole('dialog', { name: 'Search or run a command' })
  expect(within(palette).getByRole('link', { name: 'Settings' })).toBeDefined()
  // The empty palette stays the short list of destinations.
  expect(within(palette).queryByRole('link', { name: /^Settings: / })).toBeNull()
  fireEvent.change(within(palette).getByLabelText('Search destinations'), {
    target: { value: 'settings' },
  })
  for (const [, label] of titles)
    expect(within(palette).getByRole('link', { name: `Settings: ${label}` })).toBeDefined()
  fireEvent.click(within(palette).getByRole('link', { name: 'Settings: Logs' }))
  await waitFor(() => expect(here()).toBe('/settings/logs'))
})
