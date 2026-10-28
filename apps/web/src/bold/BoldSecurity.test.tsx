import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { BoldSecurity } from './BoldSecurity.tsx'

vi.mock('../data/query-client.ts', () => ({ useStreamQuery: () => ({ data: [] }) }))
vi.mock('../routes/settings/TerminalSection.tsx', () => ({ OpenTerminals: () => null }))

const browsers = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    label: 'Desktop',
    address: '10.1.1.20',
    createdAt: '2026-10-08T00:00:00.000Z',
    lastSeenAt: '2026-10-08T01:00:00.000Z',
    expiresAt: '2026-11-15T01:00:00.000Z',
    current: true,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    label: 'curl/8.18.0',
    address: '127.0.0.1',
    createdAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: '2026-10-07T01:00:00.000Z',
    expiresAt: '2026-11-14T01:00:00.000Z',
    current: false,
  },
]

let state: { passwordSet: boolean; unlockedUntil: string | null; serverNow?: string | null }
let calls: { url: string; method: string; body: unknown }[]
let browsersAnswer: 'ok' | 'locked'

const reply = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }))

beforeEach(() => {
  state = { passwordSet: true, unlockedUntil: null }
  calls = []
  browsersAnswer = 'ok'
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url === '/api/session/security')
        return reply({ ...state, origins: [], terminal: false, terminalUnavailable: null })
      if (url === '/api/session/security/unlock') {
        const body = JSON.parse(String(init?.body))
        if (body.password === 'wrong password')
          return reply({ error: { code: 'wrong_password', message: 'No' } }, 403)
        state.unlockedUntil = new Date(Date.now() + 300_000).toISOString()
        return reply({ unlockedUntil: state.unlockedUntil })
      }
      if (url === '/api/session/security/lock') {
        state.unlockedUntil = null
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (url === '/api/session/security/password' && method === 'PUT') {
        state.passwordSet = true
        state.unlockedUntil = new Date(Date.now() + 300_000).toISOString()
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (url === '/api/session/browsers') {
        if (browsersAnswer === 'locked')
          return reply({ error: { code: 'locked', message: 'Locked' } }, 403)
        return reply({ items: browsers })
      }
      if (url === '/api/session/passkeys') return reply({ available: true, rpId: 'x.y', items: [] })
      return Promise.resolve(new Response(null, { status: 204 }))
    }),
  )
})

afterEach(async () => {
  cleanup()
  // Leaving locks a tick later (so a development double-mount doesn't lock): let it land before the next test's stub.
  await new Promise((resolve) => setTimeout(resolve, 10))
  vi.unstubAllGlobals()
})

function page() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BoldSecurity />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const unlockedIn = (ms: number) => new Date(Date.now() + ms).toISOString()

test('locked: only the lock card shows, and no locked query runs', async () => {
  page()
  const lock = await screen.findByRole('region', { name: 'This section is locked' })
  expect(lock.getAttribute('data-protected')).toBe('flex')
  expect(screen.queryByRole('heading', { name: 'Paired devices' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Check password' })).toBeNull()
  expect(calls.map((call) => call.url)).toEqual(['/api/session/security'])
})

test('unlocking sends the password once, clears the field and opens the section', async () => {
  page()
  const field = await screen.findByLabelText('Security password')
  fireEvent.change(field, { target: { value: 'wrong password' } })
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
  expect((await screen.findByRole('alert')).textContent).toBe('That is not the security password.')
  expect((screen.getByLabelText('Security password') as HTMLInputElement).value).toBe('')
  fireEvent.change(screen.getByLabelText('Security password'), {
    target: { value: 'correct horse battery' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
  expect(await screen.findByRole('heading', { name: 'Paired devices' })).toBeDefined()
  expect(screen.getByText(/Unlocked · locks in [45]:\d\d/)).toBeDefined()
  expect(document.querySelector('.bold-security-open')?.getAttribute('data-protected')).toBe('grid')
  expect(calls.filter((call) => call.url.endsWith('/unlock')).at(-1)?.body).toEqual({
    password: 'correct horse battery',
  })
})

test('unlocked: devices, actions without a password, script tag, and the old box is gone', async () => {
  state.unlockedUntil = unlockedIn(290_000)
  page()
  const list = await screen.findByRole('list', { name: 'Paired browsers' })
  expect(await within(list).findByText('this one')).toBeDefined()
  expect(within(list).getByText('not a browser')).toBeDefined()
  expect(document.querySelector('input[type="password"]')).toBeNull()
  expect(screen.queryByText(/password above/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'End curl/8.18.0' }))
  await screen.findByText('Pairing ended.')
  const revoke = calls.find((call) => call.url.endsWith('/revoke'))!
  expect(revoke.body).toEqual({})
  fireEvent.click(screen.getByRole('button', { name: 'Get a pairing link' }))
  await waitFor(() => expect(calls.some((call) => call.url.endsWith('/pairing-links'))).toBe(true))
  expect(calls.find((call) => call.url.endsWith('/pairing-links'))?.body).toEqual({})
  // The status is read again after each action: each use pushes the unlock out.
  expect(calls.filter((call) => call.url === '/api/session/security').length).toBeGreaterThan(1)
})

test('Change password asks for current, new and again, and sends current', async () => {
  state.unlockedUntil = unlockedIn(290_000)
  page()
  fireEvent.click(await screen.findByRole('button', { name: 'Change password' }))
  const form = screen.getByRole('form', { name: 'Change the security password' })
  fireEvent.change(within(form).getByLabelText('Current password'), {
    target: { value: 'old one!!' },
  })
  fireEvent.change(within(form).getByLabelText('New password (8+ characters)'), {
    target: { value: 'new password' },
  })
  fireEvent.change(within(form).getByLabelText('New password again'), {
    target: { value: 'new password' },
  })
  fireEvent.click(within(form).getByRole('button', { name: 'Save new password' }))
  await screen.findByText('Security password changed.')
  expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
    password: 'new password',
    current: 'old one!!',
  })
})

test('Lock now locks and shows the lock card; a 403 locked answer does the same', async () => {
  state.unlockedUntil = unlockedIn(290_000)
  page()
  fireEvent.click(await screen.findByRole('button', { name: 'Lock now' }))
  await screen.findByRole('region', { name: 'This section is locked' })
  expect(calls.some((call) => call.url.endsWith('/security/lock'))).toBe(true)
  cleanup()

  state.unlockedUntil = unlockedIn(290_000)
  browsersAnswer = 'locked'
  page()
  // The server says locked although the status said unlocked (its clock ran out): back to the lock card.
  state.unlockedUntil = null
  await screen.findByRole('region', { name: 'This section is locked' })
  expect(screen.queryByRole('list', { name: 'Paired browsers' })).toBeNull()
})

test('the countdown reaching zero reads the status again and locks', async () => {
  state.unlockedUntil = unlockedIn(1200)
  page()
  await screen.findByRole('heading', { name: 'Paired devices' })
  state.unlockedUntil = null
  await screen.findByRole('region', { name: 'This section is locked' }, { timeout: 4000 })
})

test('leaving the page locks the section', async () => {
  state.unlockedUntil = unlockedIn(290_000)
  const view = page()
  await screen.findByRole('heading', { name: 'Paired devices' })
  view.unmount()
  await waitFor(() => expect(calls.some((call) => call.url.endsWith('/security/lock'))).toBe(true))
})

test('no password yet: only the first-run card, and setting it opens the section', async () => {
  state.passwordSet = false
  page()
  const card = await screen.findByRole('region', { name: 'Set a security password first' })
  expect(card.getAttribute('data-protected')).toBe('flex')
  expect(screen.queryByRole('heading', { name: 'Paired devices' })).toBeNull()
  fireEvent.change(screen.getByLabelText(/New password \(at least 8/), {
    target: { value: 'correct horse battery' },
  })
  fireEvent.change(screen.getByLabelText('The same password again'), {
    target: { value: 'correct horse battery' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Set password and open' }))
  expect(await screen.findByRole('heading', { name: 'Paired devices' })).toBeDefined()
  expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
    password: 'correct horse battery',
  })
})

test('the countdown uses the server’s time, not the device clock', async () => {
  // The device clock is 10 minutes ahead of the server: the section still has 2 minutes left.
  const serverNow = Date.now() - 600_000
  state.serverNow = new Date(serverNow).toISOString()
  state.unlockedUntil = new Date(serverNow + 120_000).toISOString()
  page()
  expect(await screen.findByText(/locks in (2:00|1:59)/)).toBeDefined()
})
