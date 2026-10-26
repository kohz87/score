import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentDetail, AgentSummary, RulesResponse } from '@score/contract'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'

class MockEventSource extends EventTarget {
  constructor(readonly url: string) {
    super()
  }
  close() {}
}
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
const rule = (id: string, label = id, pattern: string | null = id, readOnly = false) => ({
  id,
  label,
  pattern,
  readOnly,
})
const rules: RulesResponse = {
  mode: 'smart',
  goAhead: [rule('SQL DROP', 'SQL DROP'), rule('mystery', 'Mystery', 'mystery', true)],
  askMe: [rule('recursive delete', 'Recursive delete'), rule('SQL TRUNCATE', 'SQL TRUNCATE')],
  never: [rule('never:git push*', 'git push*', 'git push*')],
  drift: [{ agentId: 'builder', differs: true }],
}
const detail: AgentDetail = {
  ...builder,
  tagline: 'Builds',
  personality: { excerpt: '', source: 'SOUL.md' },
  reportsTo: null,
  worksIn: null,
  rulesFile: 'AGENTS.md',
  model: null,
  skills: [],
  memory: [],
  tools: [],
  helpersMax: null,
  routines: [],
  channels: [],
  permissions: [
    { id: 'SQL DROP', label: 'SQL DROP', level: 'allowed', inherited: true },
    { id: 'never:git push*', label: 'git push*', level: 'never', inherited: true },
  ],
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let router: ReturnType<typeof createMemoryRouter>
let registry: ReturnType<typeof createStreamQueryRegistry>
let stream: ReturnType<typeof createStreamClient>
let calls: { path: string; method: string; body: unknown }[]
let respond: (call: { path: string; method: string; body: unknown }) => Response | undefined

beforeEach(() => {
  calls = []
  respond = () => undefined
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const call = {
        path,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      }
      calls.push(call)
      const custom = respond(call)
      if (custom) return Promise.resolve(custom)
      if (path === '/api/agents') return Promise.resolve(json({ asOfSeq: 0, items: [builder] }))
      if (path === '/api/agents/builder') return Promise.resolve(json(detail))
      if (path === '/api/settings/rules') return Promise.resolve(json(rules))
      if (path === '/api/settings/providers') return Promise.resolve(json({ items: [] }))
      if (path === '/api/settings/connections')
        return Promise.resolve(json({ toolServers: [], messaging: [] }))
      return Promise.resolve(json({ error: { code: 'not_found', message: 'No' } }, 404))
    }),
  )
})
function mount(path: string) {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  stream = createStreamClient({ EventSourceImpl: MockEventSource, random: () => 0.5 })
  registry = createStreamQueryRegistry(queryClient, stream)
  router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream, queries: registry }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}
afterEach(() => {
  cleanup()
  router.dispose()
  registry.dispose()
  stream.close()
  vi.unstubAllGlobals()
})

test('Apply team rules re-applies the baseline to a drifted agent', async () => {
  respond = ({ path, method }) =>
    method === 'POST' && path === '/api/settings/rules/apply/builder'
      ? json({ ...rules, drift: [{ agentId: 'builder', differs: false }] })
      : undefined
  mount('/settings/rules')
  fireEvent.click(await screen.findByRole('button', { name: 'Apply team rules to Builder' }))
  await waitFor(() =>
    expect(calls.some((call) => call.path === '/api/settings/rules/apply/builder')).toBe(true),
  )
})
