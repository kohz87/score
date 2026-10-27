import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentDetail, AgentSummary, SystemStatus } from '@score/contract'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'

vi.mock('../../shell/use-needs-you.ts', () => ({ useNeedsYou: vi.fn(() => false) }))

class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = []
  constructor(readonly url: string) {
    super()
    MockEventSource.instances.push(this)
  }
  close() {}
  frame(value: unknown, type: string, id = '') {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value), lastEventId: id }))
  }
}

const system: SystemStatus = {
  mode: 'fake',
  hermes: { version: null, reachable: true, apiServer: true, capabilities: [], servedProfiles: [] },
  bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
  compatibility: { fingerprint: 'fake', tested: true, disabled: [] },
  agentIsolation: 'same_user',
  degraded: [],
}

const lead: AgentSummary = {
  id: 'lead',
  name: 'Lead',
  role: 'Plans the work',
  style: { color: '#6b4eff', shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: { id: 'm-1', label: 'Model One' },
  served: true,
}
const builder: AgentSummary = {
  id: 'builder',
  name: 'Builder',
  role: 'Builds it',
  style: { color: '#19c39a', shape: 'triangle' },
  status: 'working',
  activity: 'Writing the stream client',
  model: { id: 'm-2', label: 'Model Two' },
  served: true,
}
const builderDetail: AgentDetail = {
  ...builder,
  tagline: 'Builds what Lead plans.',
  personality: { excerpt: 'Calm and precise.', source: 'SOUL.md' },
  reportsTo: 'lead',
  worksIn: '/srv/app',
  rulesFile: 'AGENTS.md',
  model: { id: 'm-2', label: 'Model Two', via: 'a sign-in', fallback: null },
  skills: [{ name: 'Git', enabled: true }],
  memory: [],
  tools: [{ id: 'terminal', label: 'Terminal', kind: 'builtin', enabled: true }],
  helpersMax: 3,
  routines: [],
  channels: [],
  permissions: [{ id: 'push', label: 'Push to git', level: 'asks', inherited: false }],
}

type Responder = (path: string, init?: RequestInit) => Response | Promise<Response>
let respond: Responder
const modelSettings = {
  effort: null,
  fallbacks: [
    { provider: 'acme', model: 'alpha-model' },
    { provider: 'acme', model: 'beta-model' },
  ],
  fallbacksEditable: true,
  aliases: [
    { name: 'fast', model: 'm-fast', provider: 'acme', editable: true },
    { name: 'gated', model: 'm-gated', provider: 'custom', editable: false },
  ],
  speech: {
    stt: { provider: null, model: null },
    tts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy' },
  },
}
let router: ReturnType<typeof createMemoryRouter>
let stream: ReturnType<typeof createStreamClient>
let registry: ReturnType<typeof createStreamQueryRegistry>
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function renderTeam(path: string) {
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
  const source = MockEventSource.instances.at(-1)!
  act(() => {
    source.frame(
      { type: 'stream.hello', data: { epoch: 'e1', headSeq: 0, mode: 'fake', system } },
      'stream.hello',
    )
  })
  return source
}

beforeEach(() => {
  MockEventSource.instances = []
  respond = (path) => {
    if (path === '/api/agents') return json({ asOfSeq: 0, items: [lead, builder] })
    if (path === '/api/agents/builder') return json(builderDetail)
    if (path === '/api/agents/builder/model-settings') return json(structuredClone(modelSettings))
    if (path.startsWith('/api/models')) return json({ items: [] })
    return json({ error: { code: 'not_found', message: 'No such agent' } }, 404)
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => Promise.resolve(respond(path, init))),
  )
})
afterEach(() => {
  cleanup()
  router.dispose()
  registry.dispose()
  stream.close()
  vi.unstubAllGlobals()
})

test('list shows an empty state', async () => {
  respond = () => json({ asOfSeq: 0, items: [] })
  renderTeam('/team')
  expect(await screen.findByRole('heading', { name: 'No agents yet' })).toBeDefined()
})

test('profile copes with an unreadable model', async () => {
  const detail = { ...builderDetail, model: null }
  respond = (path) =>
    path === '/api/agents'
      ? json({ asOfSeq: 0, items: [{ ...builder, model: null }] })
      : json(detail)
  renderTeam('/team/builder')
  expect(await screen.findByText('Model unavailable')).toBeDefined()
})

test('profile shows an error for an unknown agent', async () => {
  renderTeam('/team/ghost')
  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Agent unavailable')).toBeDefined()
})
