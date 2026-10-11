import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import { PasskeysPanel } from './PasskeysPanel.tsx'

const browser = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
}))
vi.mock('@simplewebauthn/browser', () => browser)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function panel(password = 'correct horse') {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PasskeysPanel
        password={password}
        origins={['https://192.168.1.2:8741', 'https://score.example.ts.net:8741']}
      />
    </QueryClientProvider>,
  )
}

const item = {
  id: 'abc',
  label: 'Phone',
  createdAt: '2026-10-09T00:00:00.000Z',
  lastUsedAt: null,
  flagged: false,
}

test('on a LAN IP it explains and links to the ts.net address instead of offering to add one', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(json({ available: false, rpId: null, items: [] })),
  )
  panel()
  expect(await screen.findByText(/don.t work on a LAN IP address/)).toBeDefined()
  expect(screen.getByRole('link', { name: 'https://score.example.ts.net:8741' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull()
})

test('adding a passkey sends the password, runs the browser ceremony, then stores it', async () => {
  const calls: { url: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.endsWith('/registration-options')) return json({ challenge: 'c' })
      if (url.endsWith('/passkeys') && init?.method === 'POST') return json(item, 201)
      return json({ available: true, rpId: 'score.example.ts.net', items: [] })
    }),
  )
  browser.startRegistration.mockResolvedValue({ id: 'abc' })
  panel()
  fireEvent.change(await screen.findByLabelText('Passkey name'), { target: { value: 'Laptop' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }))
  await screen.findByText('Passkey added.')
  expect(calls.find((call) => call.url.endsWith('/registration-options'))?.body).toEqual({
    password: 'correct horse',
    label: 'Laptop',
  })
  expect(browser.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } })
  expect(calls.at(-2)?.body).toEqual({ response: { id: 'abc' } })
})

test('removal needs the password, and says that terminating pairings keeps passkeys', async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? new Response(null, { status: 204 })
      : json({ available: true, rpId: 'x.y', items: [item] }),
  )
  vi.stubGlobal('fetch', fetch)
  panel('short')
  expect(await screen.findByText(/Ending other pairings does not remove passkeys/)).toBeDefined()
  const remove = (await screen.findByRole('button', {
    name: 'Remove passkey Phone',
  })) as HTMLButtonElement
  expect(remove.disabled).toBe(true)
  cleanup()
  panel()
  fireEvent.click(await screen.findByRole('button', { name: 'Remove passkey Phone' }))
  await waitFor(() => expect(screen.getByText('Passkey removed.')).toBeDefined())
  const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!
  expect(post[0]).toBe('/api/session/passkeys/abc/remove')
  expect(JSON.parse(String(post[1]!.body))).toEqual({ password: 'correct horse' })
})
