import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createBrowserRouter, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App, appRoutes } from './App.tsx'
import { destinations } from './shell/destinations.ts'
import { useNeedsYou } from './shell/use-needs-you.ts'
import { createQueryClient, StreamContext } from './data/query-client.ts'
import { createStreamClient } from './data/stream.ts'
import { createStreamQueryRegistry } from './data/resync.ts'

vi.mock('./shell/use-needs-you.ts', () => ({ useNeedsYou: vi.fn(() => false) }))
vi.mock('./routes/chat/ChatPage.tsx', () => ({ ChatPage: () => <h1>Chat</h1> }))
// Team has its own tests (routes/team/team.test.tsx); the shell tests only need the route to resolve.
vi.mock('./routes/team/TeamPage.tsx', async () => {
  const { Outlet } = await import('react-router')
  return { TeamLayout: () => <Outlet />, TeamPage: () => <h1>Team</h1> }
})
vi.mock('./routes/team/AgentPage.tsx', () => ({ AgentPage: () => <h1>Team</h1> }))

const routers: ReturnType<typeof createMemoryRouter>[] = []
const disposers: (() => void)[] = []

class ShellEventSource extends EventTarget {
  close() {}
}

function renderRoute(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: ShellEventSource })
  const queries = createStreamQueryRegistry(queryClient, client)
  disposers.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  routers.push(router)
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <StreamContext value={{ client, queries }}>
          <App router={router} />
        </StreamContext>
      </QueryClientProvider>
    </StrictMode>,
  )
  return router
}

function commandButton() {
  return screen.getByRole('button', { name: /Search or run a command/ })
}

beforeEach(() => {
  window.localStorage.removeItem('score.ui')
  vi.mocked(useNeedsYou).mockReturnValue(false)
  window.history.replaceState(null, '', '/')
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            asOfSeq: 0,
            items: [],
            rooms: [],
            directs: [],
            columns: { planned: [], working: [], in_review: [], needs_you: [], done: [] },
          }),
        ),
    ),
  )
})

afterEach(() => {
  cleanup()
  routers.splice(0).forEach((router) => router.dispose())
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

const routes = [
  ['/chat', 'Chat'],
  ['/chat/general', 'Chat'],
  ['/team', 'Team'],
  ['/team/lead', 'Team'],
  ['/reports', 'Reports'],
  ['/settings', 'Settings'],
] as const

test.each(routes)('%s renders %s inside the shell with the active nav', async (path, title) => {
  renderRoute(path)
  const main = screen.getByRole('main')
  expect(within(main).getByRole('heading', { level: 1, name: title })).toBeDefined()
  expect(screen.getByRole('banner')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Your account' }).textContent).toBe('Y')
  const nav = within(screen.getByRole('navigation', { name: 'Main' }))
  expect(nav.getAllByRole('link')).toHaveLength(destinations.length)
  for (const destination of destinations) {
    expect(nav.getByRole('link', { name: destination.title }).getAttribute('aria-current')).toBe(
      destination.title === title ? 'page' : null,
    )
  }
})

test('/ redirects to /b', async () => {
  const router = renderRoute('/')
  await screen.findByRole('main')
  expect(router.state.location.pathname).toBe('/b')
})

test.each(['/unknown'])('%s shows not-found inside the shell', (path) => {
  renderRoute(path)
  expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeDefined()
  expect(screen.getByRole('banner')).toBeDefined()
  expect(screen.getAllByRole('link').some((link) => link.hasAttribute('aria-current'))).toBe(false)
})

test('palette opens on click, autofocuses, closes on Esc and restores focus', () => {
  renderRoute('/chat')
  const trigger = commandButton()
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: 'Search or run a command' })
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  const input = within(dialog).getByRole('searchbox', { name: 'Search destinations' })
  expect(document.activeElement).toBe(input)
  // The destinations; Settings' sections (PLAN 10.1) appear only once something is typed.
  expect(within(dialog).getAllByRole('link')).toHaveLength(destinations.length + 1)
  expect(
    within(dialog).getByRole('link', { name: 'Workflow runs and versions' }).getAttribute('href'),
  ).toBe('/workflows')
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test.each(['ctrlKey', 'metaKey'])('palette opens with %s+K anywhere', (modifier) => {
  renderRoute('/chat')
  fireEvent.keyDown(document, { key: 'k', [modifier]: true })
  expect(screen.getByRole('dialog')).toBeDefined()
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
})

test('palette traps forward and backward focus and makes the shell inert', () => {
  renderRoute('/chat')
  fireEvent.click(commandButton())
  const dialog = screen.getByRole('dialog')
  const first = within(dialog).getByRole('button', { name: 'Close command palette' })
  const last = within(dialog).getAllByRole('link').at(-1)!
  first.focus()
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(last)
  fireEvent.keyDown(last, { key: 'Tab' })
  expect(document.activeElement).toBe(first)
  expect(screen.getByRole('banner').parentElement?.hasAttribute('inert')).toBe(true)
})

test('Enter on the filtered input navigates and closes the palette', async () => {
  const router = renderRoute('/chat')
  const trigger = commandButton()
  fireEvent.click(trigger)
  const input = screen.getByRole('searchbox')
  fireEvent.change(input, { target: { value: '  team  ' } })
  expect(within(screen.getByRole('dialog')).getAllByRole('link')).toHaveLength(1)
  fireEvent.keyDown(input, { key: 'Enter' })
  await screen.findByRole('heading', { level: 1, name: 'Team' })
  expect(router.state.location.pathname).toBe('/team')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

test('palette options navigate on click', async () => {
  renderRoute('/chat')
  fireEvent.click(commandButton())
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Team' }))
  await screen.findByRole('heading', { level: 1, name: 'Team' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('no matching option leaves Enter harmless', () => {
  const router = renderRoute('/chat')
  fireEvent.click(commandButton())
  const input = screen.getByRole('searchbox')
  fireEvent.change(input, { target: { value: 'missing destination' } })
  expect(screen.getByText('No destinations found.')).toBeDefined()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(router.state.location.pathname).toBe('/chat')
  expect(screen.getByRole('dialog')).toBeDefined()
})

test('only a backdrop click closes the palette and restores focus', () => {
  renderRoute('/chat')
  const trigger = commandButton()
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog')
  fireEvent.click(dialog)
  expect(screen.getByRole('dialog')).toBeDefined()
  fireEvent.click(dialog.parentElement!)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

test('pairing clears the hash before posting once, including in Strict Mode', async () => {
  window.history.replaceState({ test: true }, '', '/pair?source=terminal#one-time-token')
  const fetch = vi.fn(() => {
    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('?source=terminal')
    expect(window.history.state).toEqual({ test: true })
    return Promise.resolve(new Response(null, { status: 204 }))
  })
  vi.stubGlobal('fetch', fetch)
  renderRoute('/pair#one-time-token')
  await screen.findByText('This browser is paired')
  expect(screen.getByRole('heading', { name: 'Pair this browser' })).toBeDefined()
  expect(screen.getByRole('banner')).toBeDefined()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledWith(
    '/api/session/pair',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ token: 'one-time-token' }),
      credentials: 'same-origin',
    }),
  )
})

test('invalid or expired pairing links explain how to get a new link', async () => {
  window.history.replaceState(null, '', '/pair#expired-token')
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'not_paired', message: 'Invalid token' } }), {
        status: 401,
      }),
    ),
  )
  renderRoute('/pair#expired-token')
  await screen.findByText(/invalid or expired.*Restart the server/)
  expect(window.location.hash).toBe('')
})

test.each([204, 401])('browser routing keeps the pairing hash removed after %s', async (status) => {
  window.history.replaceState(null, '', '/pair#example-token')
  const fetch = vi
    .fn()
    .mockResolvedValue(
      status === 204
        ? new Response(null, { status })
        : new Response(
            JSON.stringify({ error: { code: 'not_paired', message: 'Invalid token' } }),
            { status },
          ),
    )
  vi.stubGlobal('fetch', fetch)
  const router = createBrowserRouter(appRoutes)
  routers.push(router)
  render(
    <StrictMode>
      <App router={router} />
    </StrictMode>,
  )
  await screen.findByRole('heading', { name: 'Pair this browser' })
  expect(window.location.hash).toBe('')
  expect(window.location.pathname).toBe('/pair')
  expect(fetch).toHaveBeenCalledTimes(1)
  await act(async () => {
    await router.navigate('/pair')
  })
  await screen.findByText(/pairing link printed in the server terminal at startup/)
  expect(fetch).toHaveBeenCalledTimes(1)
})

test('pairing without a token explains the terminal link and sends no request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  renderRoute('/pair')
  await screen.findByText(/pairing link printed in the server terminal at startup/)
  expect(fetch).not.toHaveBeenCalled()
})

test('pairing handles network failures without losing the shell', async () => {
  window.history.replaceState(null, '', '/pair#one-time-token')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network failure')))
  renderRoute('/pair#one-time-token')
  await screen.findByText(/Pairing failed/)
  expect(screen.getByRole('banner')).toBeDefined()
  expect(window.location.hash).toBe('')
})

test('nav links navigate between all destinations', async () => {
  const router = renderRoute('/chat')
  for (const { path, title } of destinations) {
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: title }))
    })
    // Settings opens its first section.
    expect(router.state.location.pathname).toBe(path === '/settings' ? '/settings/models' : path)
    // Lazy pages (Knowledge, Settings, …) render a moment after navigation.
    expect(
      await screen.findByRole('heading', { level: 1, name: title }, { timeout: 5000 }),
    ).toBeDefined()
  }
})

test('/watch/:agentId renders inside the classic shell on the classic view', async () => {
  window.localStorage.setItem('score.ui', 'classic')
  renderRoute('/watch/builder')
  // The route's loader (the redirect check) runs first, so the page appears a moment later.
  await waitFor(() =>
    expect(within(screen.getByRole('main')).getByText(/the screen/)).toBeDefined(),
  )
  expect(screen.getByRole('banner')).toBeDefined()
  expect(screen.getByRole('navigation', { name: 'Main' })).toBeDefined()
})

test('on the new shell the old classic paths redirect to their /b homes and keep the query', async () => {
  for (const [from, to] of [
    ['/watch/builder?from=3', '/b/watch/builder'],
    ['/workflows', '/b/workflows'],
    ['/workflows/wf-1', '/b/workflows/wf-1'],
    ['/runs/brief-1?x=y', '/b/runs/brief-1'],
    ['/settings/look/customize/score', '/b/settings/look/customize/score'],
  ] as const) {
    const router = renderRoute(from)
    await waitFor(() => expect(router.state.location.pathname).toBe(to))
    expect(router.state.location.search).toBe(from.includes('?') ? `?${from.split('?')[1]}` : '')
    cleanup()
  }
})

test('on the classic view the classic paths stay where they are', async () => {
  window.localStorage.setItem('score.ui', 'classic')
  for (const path of ['/workflows', '/runs/brief-1', '/settings/look/customize/score']) {
    const router = renderRoute(path)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(router.state.location.pathname).toBe(path)
    cleanup()
  }
})

test.each([
  ['/now', '/b'],
  ['/now/routines', '/b/team'],
  ['/now/unknown', '/b'],
  ['/tasks', '/b'],
  ['/tasks/demo', '/b'],
  ['/u', '/b'],
  ['/u/rooms/one', '/b'],
  ['/now/watch/builder', '/b/watch/builder'],
  ['/now/flow/workflows', '/b/workflows'],
  ['/now/flow/workflows/wf-1', '/b/workflows/wf-1'],
  ['/now/flow/brief-1', '/b/runs/brief-1'],
])('%s redirects to %s', async (path, target) => {
  const router = renderRoute(path)
  await waitFor(() => expect(router.state.location.pathname).toBe(target))
})

test('old /now links keep their query string when they redirect', async () => {
  const router = renderRoute('/now/watch/builder?from=12')
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/watch/builder'))
  expect(router.state.location.search).toBe('?from=12')
})

test('the palette lists matching messages in a Messages section that opens the hit', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith('/api/search/messages')
        ? new Response(
            JSON.stringify({
              items: [
                {
                  messageId: 'm1',
                  roomId: 'room-1',
                  roomName: '#launch',
                  author: { kind: 'you' },
                  createdAt: '2026-10-08T10:00:00.000Z',
                  snippet: 'the [[needle]] is here',
                },
              ],
            }),
          )
        : new Response(JSON.stringify({ asOfSeq: 0, items: [], rooms: [], directs: [] })),
    ),
  )
  const router = renderRoute('/chat')
  fireEvent.click(commandButton())
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'needle' } })
  const section = await screen.findByRole('region', { name: 'Messages' })
  expect(within(section).getByText('needle').tagName).toBe('MARK')
  expect(within(section).getByText('#launch')).toBeDefined()
  fireEvent.click(within(section).getByRole('link'))
  expect(router.state.location.pathname).toBe('/chat/room-1')
  expect(router.state.location.search).toBe('?message=m1')
  expect(screen.queryByRole('dialog')).toBeNull()
})
