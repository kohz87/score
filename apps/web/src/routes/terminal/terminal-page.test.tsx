import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TerminalPage } from './TerminalPage.tsx'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    onData() {}
    write() {}
    focus() {}
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => false,
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}))

const sockets: { close: ReturnType<typeof vi.fn> }[] = []
beforeEach(() => {
  sockets.length = 0
  vi.stubGlobal(
    'WebSocket',
    class {
      static OPEN = 1
      readyState = 0
      close = vi.fn()
      constructor() {
        sockets.push(this)
      }
    },
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Resolves each call to a path only when the test says so. */
function delayedFetch() {
  const waiting = new Map<string, () => void>()
  const fetchMock = vi.fn((input: string) => {
    const path = String(input)
    if (path.endsWith('/session/security'))
      return Promise.resolve(
        json({ passwordSet: true, origins: [], terminal: true, terminalUnavailable: null }),
      )
    return new Promise<Response>((resolve) => {
      waiting.set(path, () =>
        resolve(
          path.endsWith('/terminal/tickets')
            ? json({ ticket: 't'.repeat(43), expiresAt: '2026-10-09T10:00:00.000Z' })
            : new Response(null, { status: 204 }),
        ),
      )
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return waiting
}

async function submit() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TerminalPage />
    </QueryClientProvider>,
  )
  const password = await screen.findByLabelText('Security password')
  fireEvent.change(password, { target: { value: 'correct horse' } })
  fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
}

test('leaving while the password check is pending opens nothing', async () => {
  const waiting = delayedFetch()
  await submit()
  await waitFor(() => expect(waiting.has('/api/session/security/check')).toBe(true))
  cleanup()
  waiting.get('/api/session/security/check')!()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(waiting.has('/api/terminal/tickets')).toBe(false)
  expect(sockets).toHaveLength(0)
})

test('leaving while the ticket is pending opens no socket', async () => {
  const waiting = delayedFetch()
  await submit()
  await waitFor(() => expect(waiting.has('/api/session/security/check')).toBe(true))
  waiting.get('/api/session/security/check')!()
  await waitFor(() => expect(waiting.has('/api/terminal/tickets')).toBe(true))
  cleanup()
  waiting.get('/api/terminal/tickets')!()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(sockets).toHaveLength(0)
})

test('staying on the page opens the socket and closes it on leaving', async () => {
  const waiting = delayedFetch()
  await submit()
  await waitFor(() => expect(waiting.has('/api/session/security/check')).toBe(true))
  waiting.get('/api/session/security/check')!()
  await waitFor(() => expect(waiting.has('/api/terminal/tickets')).toBe(true))
  waiting.get('/api/terminal/tickets')!()
  await waitFor(() => expect(sockets).toHaveLength(1))
  cleanup()
  expect(sockets[0]!.close).toHaveBeenCalled()
})
