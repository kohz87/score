import type { AgentSummary } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App, appRoutes } from '../App.tsx'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { immediateFrameScheduler, createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { jsonResponse, reportFixture } from '../test/reports-fixtures.ts'

const agents: AgentSummary[] = [
  {
    id: 'lead',
    name: 'lead',
    role: 'Leads the team',
    style: { color: '#6B4EFF', shape: 'circle-dot' },
    status: 'idle',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
  {
    id: 'builder',
    name: 'builder',
    role: 'Builds features',
    style: { color: '#19C39A', shape: 'triangle' },
    status: 'working',
    activity: 'Adding feed pagination',
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
  {
    id: 'reviewer',
    name: 'reviewer',
    role: 'Reviews changes',
    style: { color: '#FFB61E', shape: 'diamond' },
    status: 'waiting',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
  {
    id: 'designer',
    name: 'designer',
    role: 'Designs interfaces',
    style: { color: '#FF6B8A', shape: 'square' },
    status: 'idle',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
]

class Source extends EventTarget {
  close() {}
}

let phone = false
const disposers: (() => void)[] = []

beforeEach(() => {
  phone = false
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query === '(max-width: 860px)' ? phone : false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      url.searchParams.delete('tz')
      if (url.pathname === '/api/agents')
        return Promise.resolve(Response.json({ asOfSeq: 1, items: agents }))
      if (url.pathname === '/api/reports')
        return Promise.resolve(
          jsonResponse(
            reportFixture((url.searchParams.get('range') as 'today' | '7d' | '30d' | null) ?? '7d'),
          ),
        )
      return Promise.resolve(
        Response.json(
          {
            asOfSeq: 0,
            items: [],
            rooms: [],
            directs: [],
            projects: [],
            columns: { planned: [], working: [], in_review: [], needs_you: [], done: [] },
          },
          { status: 200 },
        ),
      )
    }),
  )
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

function open(path: string) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source as never })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  disposers.push(() => {
    router.dispose()
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
  return router
}

test('/b draws the frame and the dock', async () => {
  open('/b')
  expect(screen.getByRole('banner')).toBeDefined()
  expect(screen.getByRole('main')).toBeDefined()
  expect(screen.getByRole('complementary', { name: 'Side panel' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Score, go to the team room' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Team' })).toBeDefined()
  const roomTitle = screen.getByRole('button', { name: 'Team room' })
  expect(roomTitle.hasAttribute('aria-haspopup')).toBe(false)
  expect(roomTitle.hasAttribute('aria-expanded')).toBe(false)

  const dock = screen.getByRole('group', { name: /Your team/ })
  expect(within(dock).queryByText('Rings show progress')).toBeNull()
  await within(dock).findByRole('button', { name: 'One to one with builder, working' })
  const rings = within(dock).getAllByRole('button')
  expect(rings).toHaveLength(agents.length)
  for (const agent of agents) {
    const ring = within(dock).getByRole('button', {
      name: new RegExp(`^One to one with ${agent.id}, `),
    })
    expect(ring.querySelector('.agent-glyph')).not.toBeNull()
    // The frame's glyph is the shape without eyes, as the prototype draws it.
    expect(ring.querySelector('.agent-glyph__eyes')).toBeNull()
  }

  const builder = within(dock).getByRole('button', { name: 'One to one with builder, working' })
  expect(builder.hasAttribute('data-progress')).toBe(false)
  expect(builder.getAttribute('style')).toContain('var(--line)')
  expect(builder.getAttribute('style')).not.toContain('conic-gradient')
  const idle = within(dock).getByRole('button', { name: 'One to one with lead, free' })
  expect(idle.hasAttribute('data-progress')).toBe(false)
  expect(idle.getAttribute('style')).not.toContain('conic-gradient')
  const needs = within(dock).getByRole('button', {
    name: 'One to one with reviewer, needs you',
  })
  expect(needs.className).toContain('needs')
})

test('the side-panel dropdown is a disclosure that closes and restores focus', () => {
  open('/b')
  const toggle = screen.getByRole('button', { name: 'Work' })
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  const menuId = toggle.getAttribute('aria-controls')
  expect(menuId).not.toBeNull()
  const menu = document.getElementById(menuId!)!
  expect(menu).not.toBeNull()
  expect(menu.querySelector('[role="listbox"], [role="option"]')).toBeNull()
  expect(within(menu).getByRole('button', { name: /^Work/ }).getAttribute('aria-current')).toBe(
    'true',
  )
  expect(
    within(menu)
      .getByRole('button', { name: /^Library/ })
      .hasAttribute('aria-current'),
  ).toBe(false)

  fireEvent.click(within(menu).getByRole('button', { name: /^Library/ }))
  expect(screen.getByText('The Library panel comes in a later task.')).toBeDefined()
  expect(document.getElementById(menuId!)).toBeNull()
  expect(document.activeElement).toBe(toggle)

  fireEvent.click(toggle)
  expect(document.getElementById(menuId!)).not.toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(document.getElementById(menuId!)).toBeNull()
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(toggle)
})

test('a phone keeps the wordmark and avatar, shows the tab bar and hides the side panel', () => {
  phone = true
  open('/b')
  const nav = screen.getByRole('navigation', { name: 'Main' })
  for (const label of ['Room', 'Team', 'Search', 'Settings'])
    expect(within(nav).getByRole('button', { name: label })).toBeDefined()
  expect(screen.queryByRole('complementary', { name: 'Side panel' })).toBeNull()
  expect(screen.queryByRole('group', { name: /Your team/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Score, go to the team room' })).toBeDefined()
  expect(screen.getByText('Y')).toBeDefined()
})

test('Team is a placeholder, Settings opens Usage, and the search button and Ctrl+K open the palette', async () => {
  open('/b')
  fireEvent.click(screen.getByRole('button', { name: 'Team' }))
  expect(await screen.findByRole('heading', { name: 'Team' })).toBeDefined()
  expect(screen.getByText('Team comes in 11.8')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Usage' })).toBeDefined()

  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  const palette = await screen.findByRole('dialog', { name: 'Search or run a command' })
  fireEvent.click(within(palette).getByRole('button', { name: 'Close command palette' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
  expect(await screen.findByRole('dialog', { name: 'Search or run a command' })).toBeDefined()
})

test('Settings offers the way back to the classic view', async () => {
  const router = open('/b/settings')
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Use the classic view' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/now'))
  expect(window.localStorage.getItem('score.ui')).toBeNull()
})

test.each(['ctrlKey', 'metaKey'])(
  '%s+K does nothing while the palette is already open',
  async (modifier) => {
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
      run(0)
      return 1
    })
    open('/b')
    const trigger = screen.getByRole('button', { name: 'Search' })
    trigger.focus()
    fireEvent.click(trigger)
    const palette = await screen.findByRole('dialog', { name: 'Search or run a command' })
    fireEvent.keyDown(document, { key: 'k', [modifier]: true })
    expect(screen.getByRole('dialog', { name: 'Search or run a command' })).toBeDefined()
    fireEvent.click(within(palette).getByRole('button', { name: 'Close command palette' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  },
)

test('the index follows the per-device choice and ?ui= sets it', async () => {
  const bold = open('/?ui=bold')
  await waitFor(() => expect(bold.state.location.pathname).toBe('/b'))
  expect(window.localStorage.getItem('score.ui')).toBe('bold')
})

test('without the bold choice the index stays exactly where it was', async () => {
  const classic = open('/?ui=classic')
  await waitFor(() => expect(classic.state.location.pathname).toBe('/now'))
  expect(window.localStorage.getItem('score.ui')).toBeNull()
})
