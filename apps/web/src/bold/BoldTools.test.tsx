import type { AgentSummary } from '@score/contract'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { BoldTools } from './BoldTools.tsx'

const builder: AgentSummary = {
  id: 'builder',
  name: 'Builder',
  role: 'Builds it',
  style: { color: '#19c39a', shape: 'triangle' },
  status: 'idle',
  activity: null,
  model: { id: 'm-2', label: 'Model Two' },
  served: true,
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount() {
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    if (url.pathname === '/api/settings/connections')
      return Promise.resolve(
        Response.json({
          toolServers: [
            { id: 'files', label: 'files', status: 'ok', usedBy: 'everyone' },
            { id: 'notes', label: 'notes', status: 'needs_signin', usedBy: ['builder'] },
          ],
          messaging: [],
        }),
      )
    if (url.pathname === '/api/settings/tool-servers' && init?.method === 'POST')
      return Promise.resolve(
        Response.json({ next: 'run_in_terminal', command: 'hermes mcp add tickets' }),
      )
    return Promise.resolve(
      Response.json({ error: { code: 'not_found', message: 'No' } }, { status: 404 }),
    )
  })
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BoldTools agents={[builder]} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return fetch
}

test('tool servers show health and who uses them, and the add form returns the Hermes command', async () => {
  const fetch = mount()
  expect(await screen.findByText('files')).toBeDefined()
  expect(screen.getByText('Sign in again')).toBeDefined()
  expect(screen.getByText('Everyone')).toBeDefined()

  const form = screen.getByRole('form', { name: 'Add a tool server' })
  fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'tickets' } })
  fireEvent.change(within(form).getByLabelText('Address or command'), {
    target: { value: 'npx -y @example/tickets' },
  })
  fireEvent.click(within(form).getByRole('button', { name: 'Add tool server' }))
  const terminal = await screen.findByRole('group', { name: 'Run in a terminal' })
  expect(terminal.textContent).toContain('hermes mcp add tickets')
  const call = fetch.mock.calls.find(
    ([input, init]) =>
      new URL(String(input), 'http://x').pathname === '/api/settings/tool-servers' &&
      init?.method === 'POST',
  )
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    name: 'tickets',
    command: ['npx', '-y', '@example/tickets'],
  })
})

test('tool removal and test calls are not offered while the contract lacks their endpoints', async () => {
  mount()
  await screen.findByText('files')
  expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /Send a test call/ })).toBeNull()
  expect(screen.getByText(/Triggers need the 11.1d API/)).toBeDefined()
  expect(screen.getByText(/not in the API contract yet/)).toBeDefined()
})
