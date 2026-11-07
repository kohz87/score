import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { installCodingAgentTestSetup } from './coding-agent-test-helpers.ts'

installCodingAgentTestSetup()

test('Backend note: says how coding runs launch, lists the host check, and Check again posts', async () => {
  const { CodingBackend } = await import('./CodingBackend.tsx')
  const posts: string[] = []
  let kind: 'unit' | 'process-group' = 'process-group'
  const body = () => ({
    kind,
    note:
      kind === 'unit'
        ? 'Runs as a supervised system service.'
        : 'Runs without a supervisor: tools a coding CLI started may keep running until Score restarts and stops them. linger is off',
    checks: [
      {
        name: 'linger',
        ok: kind === 'unit',
        detail: kind === 'unit' ? 'linger enabled' : 'linger is off',
      },
      { name: 'python', ok: true, detail: 'Python at /usr/bin/python3' },
    ],
    checkedAt: '2026-10-12T10:00:00.000Z',
  })
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(path)
      kind = 'unit'
    }
    return new Response(JSON.stringify(body()), { headers: { 'Content-Type': 'application/json' } })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CodingBackend />
    </QueryClientProvider>,
  )
  expect(await screen.findByText(/Runs without a supervisor/)).toBeTruthy()
  expect(screen.getByText(/Host check \(1 not met\)/)).toBeTruthy()
  expect(screen.getByText(/Keeps running after you log out: not met/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
  await waitFor(() => expect(posts).toEqual(['/api/coding-agents/backend/check']))
  expect(await screen.findByText('Runs as a supervised system service.')).toBeTruthy()
  // Only what the design proves: the service's own processes, not work handed to another service or daemon (review #17).
  const promise = screen.getByText(/the service stops this agent and everything running inside it/)
  expect(promise.textContent).toContain(
    'another service, a scheduler or a background daemon isn’t covered',
  )
  expect(promise.textContent).not.toContain('everything it started')
})

test('Backend note: a paused installation says why, offers Check again and makes no supervision promise', async () => {
  const { CodingBackend } = await import('./CodingBackend.tsx')
  const note =
    'Coding runs are paused: this computer no longer meets what supervised services need (linger is off). Fix that and choose Check again.'
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          kind: 'unit',
          note,
          checks: [{ name: 'linger', ok: false, detail: 'linger is off' }],
          checkedAt: '2026-10-12T10:00:00.000Z',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CodingBackend />
    </QueryClientProvider>,
  )
  const paragraph = await screen.findByText(/Coding runs are paused/)
  expect(paragraph.getAttribute('data-backend')).toBe('paused')
  expect(screen.queryByText(/the service stops this agent/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
})
