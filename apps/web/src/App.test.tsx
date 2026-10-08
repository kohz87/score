import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
  ['/now', 'Now'],
  ['/now/routines', 'Now'],
  ['/chat', 'Chat'],
  ['/chat/general', 'Chat'],
  ['/tasks', 'Tasks'],
  ['/tasks/demo', 'Tasks'],
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
  expect(screen.getByRole('img', { name: 'You' }).textContent).toBe('Y')
  const nav = within(screen.getByRole('navigation', { name: 'Main' }))
  expect(nav.getAllByRole('link')).toHaveLength(6)
  for (const destination of destinations) {
    expect(nav.getByRole('link', { name: destination.title }).getAttribute('aria-current')).toBe(
      destination.title === title ? 'page' : null,
    )
  }
})

test('/ redirects to /now', async () => {
  const router = renderRoute('/')
  await screen.findByRole('heading', { level: 1, name: 'Now' })
  expect(router.state.location.pathname).toBe('/now')
})

test.each(['/unknown', '/now/unknown', '/tasks/demo/unknown'])(
  '%s shows not-found inside the shell',
  (path) => {
    renderRoute(path)
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeDefined()
    expect(screen.getByRole('banner')).toBeDefined()
    if (path === '/unknown') {
      expect(screen.getAllByRole('link').some((link) => link.hasAttribute('aria-current'))).toBe(
        false,
      )
    }
  },
)

test('Now has no dot by default', () => {
  renderRoute('/now')
  expect(screen.queryByRole('img', { name: 'Needs you' })).toBeNull()
})

test('Now shows an accessible dot when something needs you, even on another destination', () => {
  vi.mocked(useNeedsYou).mockReturnValue(true)
  renderRoute('/chat')
  const link = screen.getByRole('link', { name: /Now/ })
  expect(within(link).getByRole('img', { name: 'Needs you' })).toBeDefined()
})

test('palette opens on click, autofocuses, closes on Esc and restores focus', () => {
  renderRoute('/now')
  const trigger = commandButton()
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: 'Search or run a command' })
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  const input = within(dialog).getByRole('searchbox', { name: 'Search destinations' })
  expect(document.activeElement).toBe(input)
  expect(within(dialog).getAllByRole('link')).toHaveLength(6)
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test.each(['ctrlKey', 'metaKey'])('palette opens with %s+K anywhere', (modifier) => {
  renderRoute('/now')
  fireEvent.keyDown(document, { key: 'k', [modifier]: true })
  expect(screen.getByRole('dialog')).toBeDefined()
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
})

test('palette traps forward and backward focus and makes the shell inert', () => {
  renderRoute('/now')
  fireEvent.click(commandButton())
  const dialog = screen.getByRole('dialog')
  const first = within(dialog).getByRole('button', { name: 'Close command palette' })
  const last = within(dialog).getByRole('link', { name: 'Settings' })
  first.focus()
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(last)
  fireEvent.keyDown(last, { key: 'Tab' })
  expect(document.activeElement).toBe(first)
  expect(screen.getByRole('banner').parentElement?.hasAttribute('inert')).toBe(true)
})

test('Enter on the filtered input navigates and closes the palette', async () => {
  const router = renderRoute('/now')
  const trigger = commandButton()
  fireEvent.click(trigger)
  const input = screen.getByRole('searchbox')
  fireEvent.change(input, { target: { value: '  tasks  ' } })
  expect(within(screen.getByRole('dialog')).getAllByRole('link')).toHaveLength(1)
  fireEvent.keyDown(input, { key: 'Enter' })
  await screen.findByRole('heading', { level: 1, name: 'Tasks' })
  expect(router.state.location.pathname).toBe('/tasks')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

test('palette options navigate on click', async () => {
  renderRoute('/now')
  fireEvent.click(commandButton())
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Team' }))
  await screen.findByRole('heading', { level: 1, name: 'Team' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('no matching option leaves Enter harmless', () => {
  const router = renderRoute('/now')
  fireEvent.click(commandButton())
  const input = screen.getByRole('searchbox')
  fireEvent.change(input, { target: { value: 'missing destination' } })
  expect(screen.getByText('No destinations found.')).toBeDefined()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(router.state.location.pathname).toBe('/now')
  expect(screen.getByRole('dialog')).toBeDefined()
})

test('only a backdrop click closes the palette and restores focus', () => {
  renderRoute('/now')
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
  const router = renderRoute('/now')
  for (const { path, title } of destinations) {
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: title }))
    })
    expect(router.state.location.pathname).toBe(path)
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeDefined()
  }
})

// Watch has its own heading (it names the agent), but it sits in the shell under Now.
test('/now/watch/:agentId renders inside the shell with Now active', async () => {
  renderRoute('/now/watch/builder')
  const main = screen.getByRole('main')
  expect(within(main).getByText('Loading the screen…')).toBeDefined()
  expect(screen.getByRole('banner')).toBeDefined()
  const nav = within(screen.getByRole('navigation', { name: 'Main' }))
  expect(nav.getByRole('link', { name: 'Now' }).getAttribute('aria-current')).toBe('page')
})
