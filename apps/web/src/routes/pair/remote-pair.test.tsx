import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { PairPage, pairBrowser } from './PairPage.tsx'
import { RemoteSection } from '../settings/RemoteSection.tsx'
import { apiFetch } from '../../data/api.ts'
import { AppShell } from '../../shell/AppShell.tsx'

vi.mock('../../shell/use-needs-you.ts', () => ({ useNeedsYou: () => false }))
const routers: ReturnType<typeof createMemoryRouter>[] = []
afterEach(() => {
  cleanup()
  routers.splice(0).forEach((router) => router.dispose())
  document.documentElement.removeAttribute('data-score-transport')
  window.history.replaceState(null, '', '/')
  vi.unstubAllGlobals()
})

function pairPage(transport = 'http') {
  document.documentElement.setAttribute('data-score-transport', transport)
  window.history.replaceState(null, '', '/pair#one-time-token')
  const router = createMemoryRouter([{ path: '/pair', Component: PairPage, loader: pairBrowser }], {
    initialEntries: ['/pair'],
  })
  routers.push(router)
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  )
}

test.each(['http', 'tls'])(
  'remote %s pairing clears the fragment and waits for explicit consent',
  async (transport) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    pairPage(transport)
    const button = await screen.findByRole('button', { name: 'Pair this browser' })
    expect(window.location.hash).toBe('')
    expect(screen.getByText(/access to every conversation and profile/)).toBeDefined()
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(button)
    fireEvent.click(button)
    await screen.findByText('This browser is paired')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ token: 'one-time-token' })
    expect(screen.getByRole('link', { name: 'Open Score' }).getAttribute('href')).toBe('/now')
  },
)
test('a consumed remote link explains terminal regeneration', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'pairing_failed', message: 'Expired' } }), {
        status: 401,
      }),
    ),
  )
  pairPage()
  fireEvent.click(await screen.findByRole('button', { name: 'Pair this browser' }))
  await screen.findByText(/Type pair in the server terminal for a new link/)
})
test.each(['http', 'tls'])('%s shows the appropriate permanent transport warning', (transport) => {
  document.documentElement.setAttribute('data-score-transport', transport)
  const router = createMemoryRouter([{ path: '/', Component: AppShell }])
  routers.push(router)
  render(<RouterProvider router={router} />)
  if (transport === 'http') {
    expect(screen.getByLabelText('Transport warning').textContent).toContain(
      'Plain HTTP: anyone on this network could read and control Score',
    )
    expect(screen.getByRole('link', { name: 'TLS setup' }).getAttribute('href')).toBe(
      'https://tailscale.com/docs/how-to/set-up-https-certificates',
    )
  } else expect(screen.queryByLabelText('Transport warning')).toBeNull()
})
function withClient(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
test('logout uses the documented session endpoint and signals cache cleanup', async () => {
  document.documentElement.setAttribute('data-score-transport', 'http')
  const fetch = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve(
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json(url.endsWith('/browsers') ? { items: [] } : {}),
    ),
  )
  vi.stubGlobal('fetch', fetch)
  const logout = vi.fn()
  window.addEventListener('score:logout', logout)
  try {
    render(withClient(<RemoteSection />))
    fireEvent.click(screen.getByRole('button', { name: 'Log out this browser' }))
    await waitFor(() => expect(logout).toHaveBeenCalledOnce())
    const call = fetch.mock.calls.find(([, init]) => init?.method === 'DELETE')!
    expect(call[0]).toBe('/api/session')
  } finally {
    window.removeEventListener('score:logout', logout)
  }
})
test('failed logout keeps the session and offers a retry', async () => {
  document.documentElement.setAttribute('data-score-transport', 'http')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  render(withClient(<RemoteSection />))
  fireEvent.click(screen.getByRole('button', { name: 'Log out this browser' }))
  await screen.findAllByRole('alert')
  expect(
    screen.getByRole('button', { name: 'Log out this browser' }).hasAttribute('disabled'),
  ).toBe(false)
})
test('unauthorized background reads on the pairing page cannot reload and lose its token', async () => {
  document.documentElement.setAttribute('data-score-transport', 'http')
  window.history.replaceState(null, '', '/pair')
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'not_paired', message: 'Pair first' } }), {
        status: 401,
      }),
    ),
  )
  const logout = vi.fn()
  window.addEventListener('score:logout', logout)
  try {
    await expect(apiFetch('approvals')).rejects.toMatchObject({ status: 401 })
    expect(logout).not.toHaveBeenCalled()
  } finally {
    window.removeEventListener('score:logout', logout)
  }
})
