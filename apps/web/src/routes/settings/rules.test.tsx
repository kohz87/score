import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentDetail, AgentSummary, RulesResponse } from '@score/contract'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'

vi.mock('../../shell/use-needs-you.ts', () => ({ useNeedsYou: vi.fn(() => false) }))

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

test('Settings shows the three columns, the approval style with plain consequences and the guardrail note', async () => {
  mount('/settings')
  const section = await screen.findByRole('region', { name: 'Rules and approvals' })
  const go = await within(section).findByRole('group', { name: 'Go ahead' })
  expect(within(go).getByText('SQL DROP')).toBeDefined()
  expect(within(go).getByText('Mystery')).toBeDefined()
  expect(within(go).getByText('Set in Hermes')).toBeDefined()
  expect(within(go).queryByRole('button', { name: /Mystery/ })).toBeNull()
  const ask = within(section).getByRole('group', { name: 'Ask me' })
  expect(within(ask).getByText(/2 kinds of risky commands/)).toBeDefined()
  expect(
    within(within(section).getByRole('group', { name: 'Never' })).getByText('git push*'),
  ).toBeDefined()
  // "Ask me" under the guardian style is not promised as a human check.
  const smart = within(section).getByRole('radio', { name: /Guardian first/ }) as HTMLInputElement
  expect(smart.checked).toBe(true)
  expect(within(section).getByText(/asks you only when it is unsure/)).toBeDefined()
  expect(within(section).getByText(/does not guarantee you see every request/)).toBeDefined()
  expect(within(section).getByText(/guardrails, not a security boundary/)).toBeDefined()
  expect(within(section).getByText(/blocked instead/)).toBeDefined()
  expect(within(section).getByText(/Builder differs from the team rules/)).toBeDefined()
})

test('editing is staged: review shows the dry-run diff, saving sends the full baseline', async () => {
  respond = ({ path, method }) =>
    path === '/api/settings/rules?dryRun=1' && method === 'PUT'
      ? json({ preview: '+mode: manual\n+never: rm -rf *' })
      : path === '/api/settings/rules' && method === 'PUT'
        ? json({ ...rules, mode: 'manual', failed: [] })
        : undefined
  mount('/settings')
  const section = await screen.findByRole('region', { name: 'Rules and approvals' })
  await within(section).findByRole('group', { name: 'Go ahead' })
  expect(within(section).queryByRole('button', { name: 'Review changes' })).toBeNull()
  fireEvent.click(within(section).getByRole('radio', { name: /Always ask me/ }))
  fireEvent.click(within(section).getByRole('button', { name: 'Add a rule' }))
  const never = within(section).getByRole('form', { name: 'Add a Never rule' })
  fireEvent.change(within(never).getByLabelText(/Never allow commands that match/), {
    target: { value: '  rm   -rf * ' },
  })
  fireEvent.click(within(never).getByRole('button', { name: 'Add to Never' }))
  const goForm = within(section).getByRole('form', { name: 'Add a Go ahead rule' })
  fireEvent.change(within(goForm).getByLabelText(/without asking/), {
    target: { value: 'SQL TRUNCATE' },
  })
  fireEvent.click(within(goForm).getByRole('button', { name: 'Add to Go ahead' }))
  fireEvent.click(within(section).getByRole('button', { name: 'Ask me before: SQL DROP' }))
  fireEvent.click(within(section).getByRole('button', { name: 'Review changes' }))
  const changes = await within(section).findByLabelText('Changes')
  expect(changes.textContent).toContain('+never: rm -rf *')
  const dry = calls.find((call) => call.path.endsWith('dryRun=1'))!
  expect(dry.body).toEqual({
    mode: 'manual',
    goAhead: ['SQL TRUNCATE'],
    never: ['git push*', 'rm -rf *'],
  })
  expect(
    calls.filter((call) => call.method === 'PUT' && !call.path.includes('dryRun')),
  ).toHaveLength(0)
  fireEvent.click(within(section).getByRole('button', { name: 'Save for the whole team' }))
  await waitFor(() => expect(within(section).getByText('Saved for the whole team.')).toBeDefined())
  const put = calls.find((call) => call.method === 'PUT' && !call.path.includes('dryRun'))!
  expect(put.body).toEqual(dry.body)
})

test('an edit made while a save is in flight stays as an unsaved draft', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  respond = ({ path, method }) =>
    path === '/api/settings/rules?dryRun=1' && method === 'PUT'
      ? json({ preview: '+mode: manual' })
      : undefined
  const inner = globalThis.fetch
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) =>
    path === '/api/settings/rules' && init?.method === 'PUT'
      ? gate.then(() => json({ ...rules, mode: 'manual', failed: [] }))
      : inner(path, init),
  )
  mount('/settings')
  const section = await screen.findByRole('region', { name: 'Rules and approvals' })
  await within(section).findByRole('group', { name: 'Go ahead' })
  fireEvent.click(within(section).getByRole('radio', { name: /Always ask me/ }))
  fireEvent.click(within(section).getByRole('button', { name: 'Review changes' }))
  await within(section).findByLabelText('Changes')
  fireEvent.click(within(section).getByRole('button', { name: 'Save for the whole team' }))
  fireEvent.click(within(section).getByRole('radio', { name: /Guardian first/ }))
  release()
  await waitFor(() => expect(within(section).getByText('Saved for the whole team.')).toBeDefined())
  expect(
    (within(section).getByRole('radio', { name: /Guardian first/ }) as HTMLInputElement).checked,
  ).toBe(true)
  expect(within(section).queryByLabelText('Changes')).toBeNull()
})

test('Apply team rules re-applies the baseline to a drifted agent', async () => {
  respond = ({ path, method }) =>
    method === 'POST' && path === '/api/settings/rules/apply/builder'
      ? json({ ...rules, drift: [{ agentId: 'builder', differs: false }] })
      : undefined
  mount('/settings')
  fireEvent.click(await screen.findByRole('button', { name: 'Apply team rules to Builder' }))
  await waitFor(() =>
    expect(calls.some((call) => call.path === '/api/settings/rules/apply/builder')).toBe(true),
  )
})

test('the Permissions tab only offers stricter changes and explains a refusal', async () => {
  respond = ({ method }) =>
    method === 'PATCH' ? json({ error: { code: 'not_stricter', message: 'no' } }, 400) : undefined
  mount('/team/builder')
  fireEvent.click(await screen.findByRole('tab', { name: 'Permissions' }))
  const panel = screen.getByRole('tabpanel')
  expect(within(panel).getByText('SQL DROP')).toBeDefined()
  expect(within(panel).getAllByText('From the team')).toHaveLength(2)
  // No control can loosen anything: no Go ahead adder, no way to remove a Never.
  expect(within(panel).queryByRole('button', { name: /remove/i })).toBeNull()
  expect(within(panel).getByText(/guardrails, not a security boundary/)).toBeDefined()
  fireEvent.click(within(panel).getByRole('button', { name: 'Ask first before: SQL DROP' }))
  await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true))
  const patch = calls.find((call) => call.method === 'PATCH')!
  expect(patch.path).toBe('/api/agents/builder/permissions/SQL%20DROP')
  expect(patch.body).toEqual({ level: 'asks' })
  expect((await within(panel).findByRole('alert')).textContent).toMatch(/only be made stricter/)
})

test('adding a Never rule on the Permissions tab sends the never: id', async () => {
  respond = ({ method }) =>
    method === 'PATCH'
      ? json({
          id: 'never:rm -rf /tmp/*',
          label: 'rm -rf /tmp/*',
          level: 'never',
          inherited: false,
        })
      : undefined
  mount('/team/builder')
  fireEvent.click(await screen.findByRole('tab', { name: 'Permissions' }))
  const panel = screen.getByRole('tabpanel')
  fireEvent.change(within(panel).getByLabelText(/Never allow commands/), {
    target: { value: 'rm  -rf /tmp/*' },
  })
  fireEvent.click(within(panel).getByRole('button', { name: 'Add Never rule' }))
  await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true))
  const patch = calls.find((call) => call.method === 'PATCH')!
  expect(decodeURIComponent(patch.path)).toBe('/api/agents/builder/permissions/never:rm -rf /tmp/*')
  expect(patch.body).toEqual({ level: 'never' })
})

test('a preview that returns after the draft changed is ignored, and Save sends what was reviewed', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const slow = vi.mocked(globalThis.fetch)
  const original = slow.getMockImplementation()!
  let asked = false
  slow.mockImplementation(async (path, init) => {
    if (String(path) === '/api/settings/rules?dryRun=1' && init?.method === 'PUT') {
      asked = true
      await gate
      return json({ preview: '+mode: manual' })
    }
    return original(path, init)
  })
  mount('/settings')
  const section = await screen.findByRole('region', { name: 'Rules and approvals' })
  await within(section).findByRole('group', { name: 'Go ahead' })
  fireEvent.click(within(section).getByRole('radio', { name: /Always ask me/ }))
  fireEvent.click(within(section).getByRole('button', { name: 'Review changes' }))
  fireEvent.click(within(section).getByRole('radio', { name: /Never ask/ }))
  release()
  await waitFor(() => expect(asked).toBe(true))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(within(section).queryByLabelText('Changes')).toBeNull()
  expect(within(section).queryByRole('button', { name: 'Save for the whole team' })).toBeNull()
})
