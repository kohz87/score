import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

function pairPage(transport = 'tls') {
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

test.each(['tls'])(
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
test('remote pages show no plain-HTTP warning (remote mode is HTTPS-only)', () => {
  document.documentElement.setAttribute('data-score-transport', 'tls')
  const router = createMemoryRouter([{ path: '/', Component: AppShell }])
  routers.push(router)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  )
  render(withClient(<RouterProvider router={router} />))
  expect(screen.queryByLabelText('Transport warning')).toBeNull()
})
function withClient(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
test('logout uses the documented session endpoint and signals cache cleanup', async () => {
  document.documentElement.setAttribute('data-score-transport', 'tls')
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
  document.documentElement.setAttribute('data-score-transport', 'tls')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  render(withClient(<RemoteSection />))
  fireEvent.click(screen.getByRole('button', { name: 'Log out this browser' }))
  await screen.findAllByRole('alert')
  expect(
    screen.getByRole('button', { name: 'Log out this browser' }).hasAttribute('disabled'),
  ).toBe(false)
})
test('unauthorized background reads on the pairing page cannot reload and lose its token', async () => {
  document.documentElement.setAttribute('data-score-transport', 'tls')
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

const twoBrowsers = {
  items: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      label: 'Desktop',
      address: '10.1.1.20',
      createdAt: '2026-10-08T00:00:00.000Z',
      lastSeenAt: '2026-10-08T01:00:00.000Z',
      expiresAt: '2026-10-15T01:00:00.000Z',
      current: true,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      label: 'Old phone',
      address: '10.1.1.30',
      createdAt: '2026-10-01T00:00:00.000Z',
      lastSeenAt: '2026-10-07T01:00:00.000Z',
      expiresAt: '2026-10-14T01:00:00.000Z',
      current: false,
    },
  ],
}
function managementFetch(
  passwordSet: boolean,
  wrong = false,
  expiresAt = new Date(Date.now() + 15 * 60_000).toISOString(),
) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/api/session/security'))
      return Promise.resolve(Response.json({ passwordSet }))
    if (url.endsWith('/api/session/browsers')) return Promise.resolve(Response.json(twoBrowsers))
    if (wrong)
      return Promise.resolve(
        Response.json({ error: { code: 'wrong_password', message: 'No' } }, { status: 403 }),
      )
    if (url.endsWith('/api/session/pairing-links'))
      return Promise.resolve(
        Response.json({
          url: 'http://10.1.1.199:8741/pair#tok',
          expiresAt,
        }),
      )
    if (init?.method === 'PUT') return Promise.resolve(new Response(null, { status: 204 }))
    return Promise.resolve(new Response(null, { status: 204 }))
  })
}

test('pairing management stays locked until the security password is entered, then sends it', async () => {
  document.documentElement.setAttribute('data-score-transport', 'tls')
  const fetch = managementFetch(true)
  vi.stubGlobal('fetch', fetch)
  render(withClient(<RemoteSection />))
  const terminate = await screen.findByRole('button', { name: 'Terminate Old phone' })
  expect(terminate.hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Pair another device' }).hasAttribute('disabled')).toBe(
    true,
  )
  fireEvent.change(screen.getByLabelText('Security password'), {
    target: { value: 'correct horse battery' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Terminate Old phone' }))
  await screen.findByText('Pairing terminated.')
  const call = fetch.mock.calls.find(([url]) => String(url).endsWith('/revoke'))!
  expect(call[0]).toBe('/api/session/browsers/22222222-2222-4222-8222-222222222222/revoke')
  expect(JSON.parse(String(call[1]!.body))).toEqual({ password: 'correct horse battery' })
  fireEvent.click(screen.getByRole('button', { name: 'Pair another device' }))
  expect((await screen.findByRole('group', { name: 'Pairing link' })).textContent).toContain(
    'http://10.1.1.199:8741/pair#tok',
  )
})

test('a wrong security password says so', async () => {
  document.documentElement.setAttribute('data-score-transport', 'tls')
  vi.stubGlobal('fetch', managementFetch(true, true))
  render(withClient(<RemoteSection />))
  fireEvent.change(await screen.findByLabelText('Security password'), {
    target: { value: 'not the password' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Terminate all other pairings' }))
  expect((await screen.findByRole('alert')).textContent).toBe('That is not the security password.')
})

test('without a password yet, Settings asks to set one first', async () => {
  document.documentElement.setAttribute('data-score-transport', 'tls')
  const fetch = managementFetch(false)
  vi.stubGlobal('fetch', fetch)
  render(withClient(<RemoteSection />))
  const form = await screen.findByRole('form', { name: 'Set a security password' })
  expect(screen.getByText('Set a security password to manage pairings.')).toBeTruthy()
  fireEvent.change(within(form).getByLabelText('New password (8+ characters)'), {
    target: { value: 'correct horse battery' },
  })
  fireEvent.change(within(form).getByLabelText('New password again'), {
    target: { value: 'correct horse battery' },
  })
  fireEvent.click(within(form).getByRole('button', { name: 'Set password' }))
  await waitFor(() =>
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true),
  )
  expect(await screen.findByText('Security password set.')).toBeTruthy()
})

test('Check password says whether the typed password is right (5.23)', async () => {
  document.documentElement.setAttribute('data-score-transport', 'tls')
  const fetch = managementFetch(true)
  vi.stubGlobal('fetch', fetch)
  render(withClient(<RemoteSection />))
  const check = await screen.findByRole('button', { name: 'Check password' })
  expect(check.hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText('Security password'), {
    target: { value: 'correct horse battery' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Check password' }))
  expect(await screen.findByText('That is the security password.')).toBeTruthy()
  const call = fetch.mock.calls.find(([url]) => String(url).endsWith('/security/check'))!
  expect(JSON.parse(String(call[1]!.body))).toEqual({ password: 'correct horse battery' })
  cleanup()
  vi.stubGlobal('fetch', managementFetch(true, true))
  render(withClient(<RemoteSection />))
  fireEvent.change(await screen.findByLabelText('Security password'), {
    target: { value: 'not the password' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Check password' }))
  expect((await screen.findByRole('alert')).textContent).toBe('That is not the security password.')
})

test('the pairing link comes with a QR code that goes away when the link expires', async () => {
  document.documentElement.setAttribute('data-score-transport', 'tls')
  vi.stubGlobal('fetch', managementFetch(true, false, new Date(Date.now() + 300).toISOString()))
  render(withClient(<RemoteSection />))
  await screen.findByRole('button', { name: 'Terminate Old phone' })
  fireEvent.change(screen.getByLabelText('Security password'), {
    target: { value: 'correct horse battery' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Pair another device' }))
  await screen.findByRole('img', { name: 'QR code for the pairing link' })
  await screen.findByText(/That link expired/)
  expect(screen.queryByRole('img', { name: 'QR code for the pairing link' })).toBeNull()
})

test('choosing another address clears the pairing link and QR minted for the previous one', async () => {
  document.documentElement.setAttribute('data-score-transport', 'tls')
  const base = managementFetch(true)
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      url.endsWith('/api/session/security')
        ? Promise.resolve(
            Response.json({
              passwordSet: true,
              origins: ['http://10.1.1.199:8741', 'https://box.tail1234.ts.net'],
            }),
          )
        : base(url, init),
    ),
  )
  render(withClient(<RemoteSection />))
  await screen.findByRole('button', { name: 'Terminate Old phone' })
  fireEvent.change(screen.getByLabelText('Security password'), {
    target: { value: 'correct horse battery' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Pair another device' }))
  await screen.findByRole('img', { name: 'QR code for the pairing link' })
  fireEvent.click(screen.getAllByRole('radio')[1]!)
  expect(screen.queryByRole('img', { name: 'QR code for the pairing link' })).toBeNull()
  expect(screen.queryByRole('group', { name: 'Pairing link' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Pair another device' })).toBeDefined()
})
