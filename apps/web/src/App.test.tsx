import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createBrowserRouter, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App, appRoutes, hashOf } from './App.tsx'
import { createQueryClient, StreamContext } from './data/query-client.ts'
import { createStreamClient } from './data/stream.ts'
import { createStreamQueryRegistry } from './data/resync.ts'

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

beforeEach(() => {
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

test('/ redirects to /b', async () => {
  const router = renderRoute('/')
  await screen.findByRole('main')
  expect(router.state.location.pathname).toBe('/b')
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
  expect(window.location.hash).toBe('')
})

test('the redirect keeps the #hash only when the browser address is the page being opened', () => {
  const here = { pathname: '/runs/b1', search: '?x=1', hash: '#step' }
  expect(hashOf(new URL('http://h/runs/b1?x=1'), here)).toBe('#step')
  expect(hashOf(new URL('http://h/runs/b2?x=1'), here)).toBe('')
  expect(hashOf(new URL('http://h/runs/b1?x=1#own'), here)).toBe('#own')
})

test('on the new shell the old classic paths redirect to their /b homes and keep the query', async () => {
  for (const [from, to] of [
    ['/watch/builder?from=3', '/b/screen/builder'],
    ['/workflows', '/b/recipes'],
    ['/workflows/wf-1', '/b/recipes/wf-1'],
    ['/b/workflows', '/b/recipes'],
    ['/b/workflows/wf-1', '/b/recipes/wf-1'],
    ['/settings/look/customize/score', '/b/settings/look/customize/score'],
  ] as const) {
    const router = renderRoute(from)
    await waitFor(() => expect(router.state.location.pathname).toBe(to))
    expect(router.state.location.search).toBe(from.includes('?') ? `?${from.split('?')[1]}` : '')
    cleanup()
  }
})

test('the old recipe dialog address opens the Recipes page and keeps the other parameters', async () => {
  const router = renderRoute('/b?recipes=1&job=j1#x')
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/recipes'))
  expect(router.state.location.search).toBe('?job=j1')
  expect(router.state.location.hash).toBe('#x')
})

test('the old workflow addresses keep the query', async () => {
  for (const from of ['/workflows/wf-1?a=1', '/b/workflows/wf-1?a=1']) {
    const router = renderRoute(from)
    await waitFor(() => expect(router.state.location.pathname).toBe('/b/recipes/wf-1'))
    expect(router.state.location.search).toBe('?a=1')
    cleanup()
  }
})

test('a run’s old addresses open it in the Runs panel and keep the query', async () => {
  for (const from of ['/runs/brief-1?x=y', '/b/runs/brief-1?x=y', '/now/flow/brief-1?x=y']) {
    const router = renderRoute(from)
    await waitFor(() => expect(router.state.location.pathname).toBe('/b'))
    expect(new URLSearchParams(router.state.location.search).get('run')).toBe('brief-1')
    expect(new URLSearchParams(router.state.location.search).get('x')).toBe('y')
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
  ['/now/watch/builder', '/b/screen/builder'],
  ['/now/flow/workflows', '/b/recipes'],
  ['/now/flow/workflows/wf-1', '/b/recipes/wf-1'],
])('%s redirects to %s', async (path, target) => {
  const router = renderRoute(path)
  await waitFor(() => expect(router.state.location.pathname).toBe(target))
})

test('old /now links keep their query string when they redirect', async () => {
  const router = renderRoute('/now/watch/builder?from=12')
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/screen/builder'))
  expect(router.state.location.search).toBe('?from=12')
})

test.each([
  ['/chat', '/b'],
  ['/chat/room-1?job=j1', '/b?room=room-1&job=j1'],
  ['/team?add=agent', '/b/team?add=agent'],
  ['/team/lead', '/b/team/lead'],
  ['/team/lead/workspace?path=a', '/b/team/lead?path=a'],
  ['/knowledge', '/b?library=1'],
  ['/knowledge/projects/plan.md', '/b?note=projects%2Fplan.md'],
  ['/reports?range=30d', '/b/settings/usage?range=30d'],
  ['/settings', '/b/settings'],
  ['/settings/rules?x=1', '/b/settings/rules?x=1'],
  ['/settings/look/customize/score?x=1', '/b/settings/look/customize/score?x=1'],
  ['/terminal', '/b/terminal'],
  ['/attempts/kr_1?x=1', '/b/attempts/kr_1?x=1'],
  ['/watch/builder?from=3', '/b/screen/builder?from=3'],
  ['/unknown', '/b'],
])('the old classic address %s leads to %s', async (from, to) => {
  const router = renderRoute(from)
  await waitFor(() =>
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(to),
  )
})
