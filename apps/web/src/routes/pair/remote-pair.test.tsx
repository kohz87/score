import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { PairPage, pairBrowser } from './PairPage.tsx'
import { apiFetch } from '../../data/api.ts'

const routers: ReturnType<typeof createMemoryRouter>[] = []
afterEach(() => {
  cleanup()
  routers.splice(0).forEach((router) => router.dispose())
  document.documentElement.removeAttribute('data-score-transport')
  window.localStorage.clear()
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
    withClient(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    ),
  )
}

test('the New look restyles pairing without changing its protected consent card', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
  pairPage()
  await screen.findByRole('button', { name: 'Pair this browser' })
  const frame = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('.bold-pair-page')
    expect(element).not.toBeNull()
    return element
  })
  expect(frame).not.toBeNull()
  expect(frame?.dataset.ui).toBe('bold')
  expect(frame?.dataset.look).toBe('dark')
  const card = document.querySelector('.pair-card')!
  expect(card.getAttribute('data-protected')).toBe('block')
  expect(screen.getByRole('button', { name: 'Pair this browser' })).toBeDefined()
})

test('the bold pairing page paints from the stored theme without asking the server for themes', async () => {
  window.localStorage.setItem('score.theme', 'light')
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetch)
  pairPage()
  await screen.findByRole('button', { name: 'Pair this browser' })
  const frame = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('.bold-pair-page')
    expect(element).not.toBeNull()
    return element
  })
  expect(frame?.dataset.look).toBe('light')
  expect(fetch).not.toHaveBeenCalled()
})

test.each(['tls'])(
  'remote %s pairing clears the fragment and waits for explicit consent',
  async (transport) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    pairPage(transport)
    const button = await screen.findByRole('button', { name: 'Pair this browser' })
    expect(window.location.hash).toBe('')
    expect(screen.getByText(/access to every room and agent/)).toBeDefined()
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(button)
    fireEvent.click(button)
    await screen.findByText('This browser is paired')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ token: 'one-time-token' })
    expect(screen.getByRole('link', { name: 'Open Score' }).getAttribute('href')).toBe('/b')
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
function withClient(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
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

test('the pairing page offers a passkey sign-in only on a domain name in a browser that supports it', async () => {
  vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {})
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
  // jsdom's host is "localhost", which counts as a domain for passkeys.
  pairPage()
  expect(await screen.findByRole('button', { name: 'Sign in with a passkey' })).toBeDefined()
})
