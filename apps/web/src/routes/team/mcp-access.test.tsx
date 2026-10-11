import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentDetail, McpAccess } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { McpAccessSection } from './McpAccessSection.tsx'

const agent = { id: 'builder', name: 'Builder' } as AgentDetail
const TOKEN = `scm_${'a'.repeat(43)}`
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let state: McpAccess
let calls: { url: string; method: string; body: unknown }[]

beforeEach(() => {
  calls = []
  state = {
    agentId: 'builder',
    enabled: false,
    writesEnabled: false,
    hasToken: false,
    tokenCreatedAt: null,
    available: true,
    url: 'http://127.0.0.1:8740/bridge/mcp',
    command:
      'hermes --profile builder mcp add score --url http://127.0.0.1:8740/bridge/mcp --auth header',
    postsThisHour: 2,
    postLimitPerHour: 30,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, boolean>)
        : undefined
      calls.push({ url, method, body })
      if (url === '/api/agents/builder/mcp') {
        if (method === 'PUT') state = { ...state, ...body }
        return Promise.resolve(json(state))
      }
      if (url === '/api/agents/builder/mcp/token') {
        state = {
          ...state,
          hasToken: method === 'POST',
          tokenCreatedAt: method === 'POST' ? '2026-10-09T10:00:00.000Z' : null,
        }
        return Promise.resolve(json(method === 'POST' ? { token: TOKEN, access: state } : state))
      }
      return Promise.resolve(json({ error: { code: 'not_found', message: 'x' } }, 404))
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount() {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  render(
    <QueryClientProvider client={queryClient}>
      <McpAccessSection agent={agent} />
    </QueryClientProvider>,
  )
}

test('both switches start off; writes cannot be turned on before access', async () => {
  mount()
  const access = await screen.findByRole('switch', { name: 'MCP access enabled for Builder' })
  const writes = screen.getByRole('switch', { name: 'MCP writes enabled for Builder' })
  expect(access.getAttribute('aria-checked')).toBe('false')
  expect(writes.getAttribute('aria-checked')).toBe('false')
  expect((writes as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(access)
  await waitFor(() => expect(access.getAttribute('aria-checked')).toBe('true'))
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: true })
  await waitFor(() => expect((writes as HTMLButtonElement).disabled).toBe(false))
})

test('the token is shown once after creating it, and the command is plain text without it', async () => {
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Create key' }))
  expect(await screen.findByText(TOKEN)).toBeDefined()
  const command = screen.getByText(/^hermes --profile builder mcp add score/)
  expect(command.textContent).not.toContain(TOKEN)
  expect(await screen.findByRole('button', { name: 'Replace key' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
  await waitFor(() => expect(screen.queryByText(TOKEN)).toBeNull())
})

test('without a bridge listener it says so and offers no token or command', async () => {
  state = { ...state, available: false, url: null, command: null }
  mount()
  expect(await screen.findByText(/Not available here/)).toBeDefined()
  expect((screen.getByRole('button', { name: 'Create key' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  expect(screen.queryByText(/hermes --profile/)).toBeNull()
})

test('first-time setup and rotation are told apart', async () => {
  mount()
  await screen.findByRole('button', { name: 'Create key' })
  expect(screen.queryByTestId('mcp-rotate-note')).toBeNull()
  expect(screen.getByText(/First-time setup/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
  const note = await screen.findByTestId('mcp-rotate-note')
  expect(note.textContent).toContain('MCP_SCORE_API_KEY')
  expect(note.textContent).toContain('won’t ask for it again')
  expect(note.textContent).not.toContain(TOKEN)
})
