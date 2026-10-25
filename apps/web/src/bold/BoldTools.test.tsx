import type { AgentSummary } from '@score/contract'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    if (init?.method === 'DELETE' && url.pathname === '/api/settings/tool-servers/notes')
      return Promise.resolve(new Response(null, { status: 204 }))
    if (url.pathname === '/api/triggers') return Promise.resolve(Response.json({ items: [] }))
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
    target: { value: 'npx -y @example/tickets --title "My tickets app"' },
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
    command: ['npx', '-y', '@example/tickets', '--title', 'My tickets app'],
  })
  expect(screen.getByText(/Don’t paste tokens or passwords into the command/)).toBeDefined()
})

test('tool testing points to Hermes while the contract lacks its endpoint', async () => {
  mount()
  await screen.findByText('files')
  expect(screen.queryByRole('button', { name: /Send a test call/ })).toBeNull()
  expect(screen.getByText(/Testing a tool server is done in Hermes for now/)).toBeDefined()
  expect(screen.getByRole('button', { name: 'New trigger' })).toBeDefined()
})

test('a command with an unclosed quote is refused before it is sent', async () => {
  const fetch = mount()
  await screen.findByText('files')
  const form = screen.getByRole('form', { name: 'Add a tool server' })
  fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'tickets' } })
  fireEvent.change(within(form).getByLabelText('Address or command'), {
    target: { value: 'npx -y "unclosed' },
  })
  fireEvent.click(within(form).getByRole('button', { name: 'Add tool server' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Close the quote in the command.')
  expect(
    fetch.mock.calls.some(
      ([input, init]) =>
        new URL(String(input), 'http://x').pathname === '/api/settings/tool-servers' &&
        init?.method === 'POST',
    ),
  ).toBe(false)
})

test('a tool server is removed only after the protected confirm', async () => {
  const fetch = mount()
  const row = (await screen.findByText('notes')).closest('[data-tool-server]') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: 'Remove notes' }))
  const confirm = within(row).getByRole('group', { name: 'Remove notes' })
  expect(confirm.getAttribute('data-protected')).toBe('block')
  expect(confirm.textContent).toContain(
    'Removes notes from Hermes. Agents drop it when the gateway restarts.',
  )
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  fireEvent.click(within(row).getByRole('button', { name: 'Remove' }))
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith('/api/settings/tool-servers/notes') && init?.method === 'DELETE',
      ),
    ).toBe(true),
  )
})
