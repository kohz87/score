import { providerAction } from './ProvidersSection.tsx'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { crossesNetworkUnencrypted } from './ApiKeyPanel.tsx'
import type { AgentSummary, ConnectionsResponse, ProviderItem } from '@score/contract'
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
const providers: ProviderItem[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    status: 'connected',
    detail: 'API key (1)',
    usedBy: ['builder'],
    signIn: 'api_key',
  },
  { id: 'anthropic', label: 'Anthropic', status: 'needs_signin', detail: 'Signed in', usedBy: [] },
  { id: 'nous', label: 'Nous Portal', status: 'missing', detail: 'Not connected', usedBy: [] },
  {
    id: 'openai-codex',
    label: 'ChatGPT (Codex)',
    status: 'missing',
    detail: 'Not connected',
    usedBy: [],
    signIn: 'device_code',
  },
]
const connections: ConnectionsResponse = {
  toolServers: [
    { id: 'files', label: 'files', status: 'ok', usedBy: 'everyone' },
    { id: 'notes', label: 'notes', status: 'needs_signin', usedBy: ['builder'] },
  ],
  messaging: [
    { platform: 'telegram', label: 'Telegram', status: 'connected', detail: null },
    { platform: 'slack', label: 'Slack', status: 'disconnected', detail: 'auth_failed' },
  ],
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let router: ReturnType<typeof createMemoryRouter>
let registry: ReturnType<typeof createStreamQueryRegistry>
let stream: ReturnType<typeof createStreamClient>
let calls: { path: string; init?: RequestInit }[]
let respond: (path: string, init?: RequestInit) => Response
// When set, the config apply response waits for it, so a test can edit while a save is in flight.
let applyGate: Promise<void> | null = null

beforeEach(() => {
  window.localStorage.removeItem('score.settings.advancedOpen')
  calls = []
  applyGate = null
  respond = (path) => {
    if (path === '/api/agents') return json({ asOfSeq: 0, items: [builder] })
    if (path === '/api/settings/providers') return json({ items: providers })
    if (path === '/api/settings/connections') return json(connections)
    return json({ error: { code: 'not_found', message: 'No' } }, 404)
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      calls.push({ path, ...(init ? { init } : {}) })
      if (applyGate && path === '/api/settings/config/apply')
        return applyGate.then(() => respond(path, init))
      return Promise.resolve(respond(path, init))
    }),
  )
})
function mount() {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  stream = createStreamClient({ EventSourceImpl: MockEventSource, random: () => 0.5 })
  registry = createStreamQueryRegistry(queryClient, stream)
  router = createMemoryRouter(appRoutes, { initialEntries: ['/settings'] })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream, queries: registry }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}
afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
  cleanup()
  router.dispose()
  registry.dispose()
  stream.close()
  vi.unstubAllGlobals()
})

test('shows the section nav, providers with status and who uses them, and connections', async () => {
  mount()
  const nav = screen.getByRole('navigation', { name: 'Settings sections' })
  expect(within(nav).getAllByRole('link')).toHaveLength(5)
  const models = await screen.findByRole('region', { name: 'Models and keys' })
  expect(await within(models).findByText('OpenRouter')).toBeDefined()
  expect(within(models).getByText('Connected')).toBeDefined()
  expect(within(models).getByText('Sign in again')).toBeDefined()
  expect(within(models).getByText('API key (1)')).toBeDefined()
  await waitFor(() => expect(within(models).getByRole('img', { name: /Builder/ })).toBeDefined())
  const connectionsRegion = await screen.findByRole('region', { name: 'Connections' })
  expect(await within(connectionsRegion).findByText('files')).toBeDefined()
  expect(within(connectionsRegion).getByText(/Everyone/)).toBeDefined()
  expect(within(connectionsRegion).getByText('Auth failed')).toBeDefined()
  expect(screen.queryByText('Coming soon.')).toBeNull()
})

test('connecting a provider shows the terminal command and never sends a credential', async () => {
  respond = (path, init) =>
    init?.method === 'POST'
      ? json({ next: 'run_in_terminal', command: 'hermes auth add nous' })
      : path === '/api/settings/providers'
        ? json({ items: providers })
        : path === '/api/agents'
          ? json({ asOfSeq: 0, items: [builder] })
          : json(connections)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Nous Portal' }))
  const group = await screen.findByRole('group', { name: 'Run in a terminal' })
  expect(within(group).getByText('hermes auth add nous')).toBeDefined()
  const post = calls.find((call) => call.init?.method === 'POST')!
  expect(post.path).toBe('/api/settings/providers/nous/connect')
  expect(post.init?.body).toBeUndefined()
})

test('adding a local model posts the form and reports the result', async () => {
  respond = (path, init) =>
    init?.method === 'POST'
      ? json({ id: 'lab', label: 'Lab', status: 'connected', detail: '10.0.0.5:8080', usedBy: [] })
      : path === '/api/settings/providers'
        ? json({ items: providers })
        : path === '/api/agents'
          ? json({ asOfSeq: 0, items: [builder] })
          : json(connections)
  mount()
  await screen.findByText('OpenRouter')
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  const form = screen.getByRole('form', { name: 'Add a local model' })
  fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Lab' } })
  fireEvent.change(within(form).getByLabelText('Address'), {
    target: { value: 'http://10.0.0.5:8080/v1' },
  })
  fireEvent.change(within(form).getByLabelText('Model'), { target: { value: 'llama-3' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Add model' }))
  expect(await screen.findByText('Added Lab.')).toBeDefined()
  const post = calls.find((call) => call.init?.method === 'POST')!
  expect(JSON.parse(String(post.init!.body))).toEqual({
    label: 'Lab',
    baseUrl: 'http://10.0.0.5:8080/v1',
    model: 'llama-3',
  })
})

test('an unpaired browser gets a pairing hint, and a failed load shows an alert', async () => {
  respond = (path, init) =>
    init?.method === 'POST'
      ? json({ error: { code: 'not_paired', message: 'Pair' } }, 401)
      : path === '/api/settings/providers'
        ? json({ error: { code: 'boom', message: 'Down' } }, 500)
        : path === '/api/agents'
          ? json({ asOfSeq: 0, items: [] })
          : json(connections)
  mount()
  expect(await screen.findByText(/Could not load providers/)).toBeDefined()
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Slack' }))
  expect(await screen.findByText(/Pair this browser/)).toBeDefined()
})

const HASH = 'a'.repeat(64)
const configItems = [
  { key: 'agent.max_turns', value: 60, file: 'config.yaml', description: 'Turn cap.' },
  { key: 'display.language', value: 'en', file: 'config.yaml', description: null },
]
function advancedRespond(apply: () => Response) {
  respond = (path, init) => {
    if (path.startsWith('/api/settings/config?')) return json({ items: configItems })
    if (path === '/api/settings/config/preview')
      return json({
        diff: '--- current\n+++ proposed\n-agent.max_turns: 60\n+agent.max_turns: 30\n',
        file: 'config.yaml',
        hash: HASH,
      })
    if (path === '/api/settings/config/apply' && init?.method === 'POST') return apply()
    if (path === '/api/agents') return json({ asOfSeq: 0, items: [builder] })
    if (path === '/api/settings/providers') return json({ items: providers })
    return json(connections)
  }
}
async function stageTurns() {
  const advanced = await screen.findByRole('region', { name: 'Advanced' })
  fireEvent.click(await within(advanced).findByRole('button', { name: /^Show all \d+ settings$/ }))
  fireEvent.click(await within(advanced).findByRole('button', { name: 'Edit agent.max_turns' }))
  fireEvent.change(within(advanced).getByLabelText('New value for agent.max_turns'), {
    target: { value: '30' },
  })
  fireEvent.click(within(advanced).getByRole('button', { name: 'Stage change' }))
  return advanced
}

test('advanced: collapsed by default, opens on click or on a search, and remembers the choice', async () => {
  window.localStorage.clear()
  advancedRespond(() => json({ ok: true, restartRequired: false }))
  mount()
  const advanced = await screen.findByRole('region', { name: 'Advanced' })
  const toggle = await within(advanced).findByRole('button', { name: 'Show all 2 settings' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(within(advanced).getByRole('searchbox', { name: 'Search settings' })).toBeDefined()
  expect(within(advanced).queryByRole('list', { name: 'Settings' })).toBeNull()
  fireEvent.click(toggle)
  expect(within(advanced).getByRole('list', { name: 'Settings' })).toBeDefined()
  expect(window.localStorage.getItem('score.settings.advancedOpen')).toBe('1')
  fireEvent.click(within(advanced).getByRole('button', { name: 'Hide settings' }))
  expect(within(advanced).queryByRole('list', { name: 'Settings' })).toBeNull()
  fireEvent.change(within(advanced).getByRole('searchbox', { name: 'Search settings' }), {
    target: { value: 'turn' },
  })
  expect(within(advanced).getByRole('list', { name: 'Settings' })).toBeDefined()
  cleanup()
  window.localStorage.setItem('score.settings.advancedOpen', '1')
  mount()
  expect(await screen.findByRole('list', { name: 'Settings' })).toBeDefined()
  window.localStorage.clear()
})

test('advanced: blocked storage still opens the list', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  advancedRespond(() => json({ ok: true, restartRequired: false }))
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Show all 2 settings' }))
  expect(screen.getByRole('list', { name: 'Settings' })).toBeDefined()
  vi.restoreAllMocks()
})

test('advanced: search, stage a change, preview the diff, then apply with the hash', async () => {
  advancedRespond(() => json({ ok: true, restartRequired: true }))
  mount()
  const advanced = await stageTurns()
  const apply = within(advanced).getByRole('button', { name: 'Apply' })
  expect((apply as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(advanced).getByRole('button', { name: 'Preview' }))
  expect(await within(advanced).findByText(/\+agent.max_turns: 30/)).toBeDefined()
  fireEvent.click(apply)
  expect(await within(advanced).findByText(/Restart the gateway/)).toBeDefined()
  const post = calls.find((call) => call.path === '/api/settings/config/apply')!
  expect(JSON.parse(String(post.init!.body))).toEqual({
    changes: [{ key: 'agent.max_turns', value: 30 }],
    expectedDiffHash: HASH,
  })
  expect(within(advanced).queryByRole('group', { name: 'Pending changes' })).toBeNull()
})
test('advanced: a 409 asks for a new preview and disables apply', async () => {
  advancedRespond(() => json({ error: { code: 'conflict', message: 'Changed' } }, 409))
  mount()
  const advanced = await stageTurns()
  fireEvent.click(within(advanced).getByRole('button', { name: 'Preview' }))
  await within(advanced).findByText(/\+agent.max_turns: 30/)
  fireEvent.click(within(advanced).getByRole('button', { name: 'Apply' }))
  expect(await within(advanced).findByText(/Preview again/)).toBeDefined()
  const apply = within(advanced).getByRole('button', { name: 'Apply' }) as HTMLButtonElement
  expect(apply.disabled).toBe(true)
})
test('advanced: editing after a preview clears the diff', async () => {
  advancedRespond(() => json({ ok: true, restartRequired: false }))
  mount()
  const advanced = await stageTurns()
  fireEvent.click(within(advanced).getByRole('button', { name: 'Preview' }))
  await within(advanced).findByText(/\+agent.max_turns: 30/)
  fireEvent.click(within(advanced).getByRole('button', { name: 'Discard agent.max_turns' }))
  expect(within(advanced).queryByText(/\+agent.max_turns: 30/)).toBeNull()
})

test('advanced: a change staged while an apply is in flight stays pending after it succeeds', async () => {
  let release!: () => void
  applyGate = new Promise<void>((resolve) => (release = resolve))
  advancedRespond(() => json({ ok: true, restartRequired: false }))
  mount()
  const advanced = await stageTurns()
  fireEvent.click(within(advanced).getByRole('button', { name: 'Preview' }))
  await within(advanced).findByText(/\+agent.max_turns: 30/)
  fireEvent.click(within(advanced).getByRole('button', { name: 'Apply' }))
  fireEvent.click(within(advanced).getByRole('button', { name: 'Edit display.language' }))
  fireEvent.change(within(advanced).getByLabelText('New value for display.language'), {
    target: { value: 'fr' },
  })
  fireEvent.click(within(advanced).getByRole('button', { name: 'Stage change' }))
  release()
  await within(advanced).findByText(/Saved\./)
  const tray = within(advanced).getByRole('group', { name: 'Pending changes' })
  expect(within(tray).getByText(/display.language = fr/)).toBeDefined()
  expect(within(tray).queryByText(/agent.max_turns/)).toBeNull()
})

test('theme choice applies data-theme, is remembered, and System clears it', async () => {
  window.localStorage.clear()
  mount()
  const look = await screen.findByRole('region', { name: 'Look' })
  // Plugins are per agent and live on the Team page now.
  expect(screen.queryByText('Hermes plugins')).toBeNull()
  expect(screen.queryByRole('region', { name: /Plugins/ })).toBeNull()
  const group = within(look).getByRole('radiogroup', { name: 'Theme' })
  fireEvent.click(within(group).getByRole('radio', { name: 'Dark' }))
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  expect(window.localStorage.getItem('score.theme')).toBe('dark')
  expect(within(group).getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe(
    'true',
  )
  fireEvent.click(within(group).getByRole('radio', { name: 'Light' }))
  expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  fireEvent.click(within(group).getByRole('radio', { name: 'System' }))
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  expect(window.localStorage.getItem('score.theme')).toBeNull()
})

test('theme still switches when storage is blocked', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  mount()
  const group = await screen.findByRole('radiogroup', { name: 'Theme' })
  fireEvent.click(within(group).getByRole('radio', { name: 'Dark' }))
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  vi.restoreAllMocks()
})

const hash = 'a'.repeat(64)
const checkOf = (compatible: boolean) => ({
  hash,
  build: { version: '0.21.6', codeSha: 'b'.repeat(40), fingerprint: 'f'.repeat(16) },
  compatible,
  parts: [
    { name: 'Hermes version', status: 'changed', detail: '0.21.5 → 0.21.6' },
    {
      name: 'Kanban database schema',
      status: compatible ? 'same' : 'changed',
      detail: compatible ? 'Unchanged.' : 'The database layout differs from the tested build.',
    },
  ],
})
function untestedHermes(compatible: boolean) {
  let tested = false
  respond = (path) => {
    if (path === '/api/system')
      return json({
        mode: 'live',
        hermes: {
          version: '0.21.6',
          reachable: true,
          apiServer: true,
          capabilities: [],
          servedProfiles: [],
        },
        bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
        compatibility: {
          fingerprint: 'f',
          tested,
          disabled: tested ? [] : ['gateway-approvals'],
        },
        agentIsolation: 'same_user',
        degraded: [],
      })
    if (path === '/api/settings/hermes/check') return json(checkOf(compatible))
    if (path === '/api/settings/hermes/accept') {
      tested = true
      return json({ ok: true })
    }
    if (path === '/api/agents') return json({ asOfSeq: 0, items: [builder] })
    if (path === '/api/settings/providers') return json({ items: providers })
    if (path === '/api/settings/connections') return json(connections)
    return json({ error: { code: 'not_found', message: 'No' } }, 404)
  }
}

test('an untested Hermes shows the banner and nav dot; one confirmed click re-enables approvals', async () => {
  untestedHermes(true)
  mount()
  const banner = await screen.findByRole('region', { name: 'Hermes was updated' })
  expect(banner.textContent).toContain(
    'Hermes was updated to 0.21.6. Approvals in Score are paused until you check this version.',
  )
  expect(await screen.findByRole('img', { name: 'Hermes version needs a check' })).toBeDefined()
  fireEvent.click(within(banner).getByRole('button', { name: 'Check this Hermes version' }))
  const table = await within(banner).findByRole('table')
  expect(within(table).getByText('0.21.5 → 0.21.6')).toBeDefined()
  fireEvent.click(within(banner).getByRole('button', { name: 'Turn approvals back on' }))
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Hermes was updated' })).toBeNull(),
  )
  expect(screen.queryByRole('img', { name: 'Hermes version needs a check' })).toBeNull()
  const accept = calls.find((call) => call.path === '/api/settings/hermes/accept')!
  expect(JSON.parse(String(accept.init?.body))).toEqual({ hash })
})

test('a changed Hermes lists what changed and offers no accept', async () => {
  untestedHermes(false)
  mount()
  const banner = await screen.findByRole('region', { name: 'Hermes was updated' })
  fireEvent.click(within(banner).getByRole('button', { name: 'Check this Hermes version' }))
  await within(banner).findByRole('table')
  expect(within(banner).getByRole('status').textContent).toContain(
    'Approvals stay paused. Changed: Hermes version, Kanban database schema.',
  )
  expect(within(banner).queryByRole('button', { name: 'Turn approvals back on' })).toBeNull()
  fireEvent.click(within(banner).getByRole('button', { name: 'Stay paused' }))
  expect(within(banner).getByRole('button', { name: 'Check this Hermes version' })).toBeDefined()
  expect(calls.some((call) => call.path === '/api/settings/hermes/accept')).toBe(false)
})

test('after signing in from the terminal, Done re-checks and the provider shows as connected', async () => {
  let signedIn = false
  respond = (path, init) =>
    init?.method === 'POST'
      ? json({ next: 'run_in_terminal', command: 'hermes auth add nous' })
      : path === '/api/settings/providers'
        ? json({
            items: providers.map((item) =>
              item.id === 'nous' && signedIn
                ? { ...item, status: 'connected', detail: 'Signed in' }
                : item,
            ),
          })
        : path === '/api/agents'
          ? json({ asOfSeq: 0, items: [builder] })
          : json(connections)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Nous Portal' }))
  const group = await screen.findByRole('group', { name: 'Run in a terminal' })
  signedIn = true // the person ran the command in their terminal
  fireEvent.click(within(group).getByRole('button', { name: 'Done' }))
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Connect Nous Portal' })).toBeNull(),
  )
  const models = screen.getByRole('region', { name: 'Models and keys' })
  expect(within(models).getAllByText('Connected')).toHaveLength(2)
})

test('a connect that finished at once shows the provider as connected without a command', async () => {
  let signedIn = false
  respond = (path, init) =>
    init?.method === 'POST'
      ? ((signedIn = true), json({ next: 'done', command: 'hermes auth add nous' }))
      : path === '/api/settings/providers'
        ? json({
            items: providers.map((item) =>
              item.id === 'nous' && signedIn
                ? { ...item, status: 'connected', detail: 'Signed in' }
                : item,
            ),
          })
        : path === '/api/agents'
          ? json({ asOfSeq: 0, items: [builder] })
          : json(connections)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Nous Portal' }))
  await screen.findByText('Nous Portal is connected.')
  expect(screen.queryByRole('group', { name: 'Run in a terminal' })).toBeNull()
})

const waitingSignIn = {
  id: 'si-1',
  providerId: 'openai-codex',
  state: 'waiting',
  url: 'https://auth.example.com/device',
  code: 'ABCD-EFGH',
  expiresAt: '2026-10-08T12:15:00.000Z',
  message: null,
}
const deviceResult = {
  next: 'device_code',
  command: 'hermes auth add openai-codex',
  url: 'https://auth.example.com/device',
  code: 'ABCD-EFGH',
  signInId: 'si-1',
  expiresAt: '2026-10-08T12:15:00.000Z',
}
function respondWith(extra: (path: string, init?: RequestInit) => Response | undefined) {
  respond = (path, init) =>
    extra(path, init) ??
    (path === '/api/settings/providers'
      ? json({ items: providers })
      : path === '/api/agents'
        ? json({ asOfSeq: 0, items: [builder] })
        : json(connections))
}

test('a device sign-in shows the link and code, follows the status and ends as connected', async () => {
  let state = 'waiting'
  respondWith((path, init) => {
    if (path === '/api/settings/providers/openai-codex/connect' && init?.method === 'POST')
      return json(deviceResult)
    if (path === '/api/settings/sign-ins/si-1')
      return json(
        state === 'waiting'
          ? waitingSignIn
          : { ...waitingSignIn, state: 'connected', url: null, code: null },
      )
    return undefined
  })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Connect ChatGPT (Codex)' }))
  const panel = await screen.findByRole('group', { name: 'Sign in to ChatGPT (Codex)' })
  const link = within(panel).getByRole('link', { name: 'Open the sign-in page' })
  expect(link.getAttribute('href')).toBe('https://auth.example.com/device')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  expect(within(panel).getByLabelText('Sign-in code').textContent).toBe('ABCD-EFGH')
  expect(within(panel).getByText('Waiting for you to approve…')).toBeDefined()
  expect(within(panel).getByRole('button', { name: 'Copy code' })).toBeDefined()
  expect(within(panel).getByRole('button', { name: 'Use a terminal instead' })).toBeDefined()
  // The next poll finds the sign-in approved: the panel says connected and the providers are re-read.
  state = 'connected'
  const before = calls.filter((call) => call.path === '/api/settings/providers').length
  await within(panel).findByText('ChatGPT (Codex) is connected.', {}, { timeout: 4000 })
  await waitFor(() =>
    expect(calls.filter((call) => call.path === '/api/settings/providers').length).toBeGreaterThan(
      before,
    ),
  )
}, 10_000)

test('cancelling a device sign-in calls DELETE and closes the panel; the terminal fallback shows the command', async () => {
  respondWith((path, init) => {
    if (path === '/api/settings/providers/openai-codex/connect' && init?.method === 'POST')
      return json(deviceResult)
    if (path === '/api/settings/sign-ins/si-1' && init?.method === 'DELETE')
      return json({ ...waitingSignIn, state: 'cancelled', url: null, code: null })
    if (path === '/api/settings/sign-ins/si-1') return json(waitingSignIn)
    return undefined
  })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Connect ChatGPT (Codex)' }))
  const panel = await screen.findByRole('group', { name: 'Sign in to ChatGPT (Codex)' })
  fireEvent.click(within(panel).getByRole('button', { name: 'Use a terminal instead' }))
  expect(await screen.findByText('hermes auth add openai-codex')).toBeDefined()
  expect(screen.queryByRole('group', { name: 'Sign in to ChatGPT (Codex)' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Connect ChatGPT (Codex)' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
  await waitFor(() =>
    expect(screen.queryByRole('group', { name: 'Sign in to ChatGPT (Codex)' })).toBeNull(),
  )
  expect(
    calls.some(
      (call) => call.path === '/api/settings/sign-ins/si-1' && call.init?.method === 'DELETE',
    ),
  ).toBe(true)
})

test('a failed device sign-in offers to try again', async () => {
  respondWith((path, init) => {
    if (path === '/api/settings/providers/openai-codex/connect' && init?.method === 'POST')
      return json(deviceResult)
    if (path === '/api/settings/sign-ins/si-1')
      return json({
        ...waitingSignIn,
        state: 'expired',
        url: null,
        code: null,
        message: 'The code expired. Start the sign-in again.',
      })
    return undefined
  })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Connect ChatGPT (Codex)' }))
  expect(await screen.findByText('The code expired. Start the sign-in again.')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined()
})

test('a connected row offers only an edit flow that works', async () => {
  const row = (over: Partial<ProviderItem>): ProviderItem => ({
    id: 'x',
    label: 'X',
    status: 'connected',
    detail: 'ok',
    usedBy: [],
    ...over,
  })
  expect(providerAction(row({ signIn: 'api_key' }))).toBe('Add key')
  expect(providerAction(row({ signIn: 'device_code' }))).toBeNull()
  expect(providerAction(row({ signIn: 'terminal' }))).toBeNull()
  expect(providerAction(row({}))).toBeNull()
  expect(providerAction(row({ status: 'needs_signin', signIn: 'terminal' }))).toBe('Reconnect')
  expect(providerAction(row({ status: 'missing' }))).toBe('Connect')
  respondWith(() => undefined)
  mount()
  await screen.findByText('OpenRouter')
  expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull()
  expect(screen.getByRole('button', { name: 'Reconnect Anthropic' })).toBeDefined()
})

const KEY = 'sk-or-v1-typed-by-the-person-0001'
test('a pasted key is sent once in the request body, never shown, and cleared afterwards', async () => {
  respondWith((path, init) =>
    path === '/api/settings/providers/openrouter/key' && init?.method === 'POST'
      ? json({ ...providers[0], detail: 'API key (2)' })
      : undefined,
  )
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Add key OpenRouter' }))
  const form = await screen.findByRole('form', { name: 'Add a key for OpenRouter' })
  const input = within(form).getByLabelText('API key') as HTMLInputElement
  expect(input.type).toBe('password')
  expect(input.autocomplete).toBe('off')
  expect(input.getAttribute('spellcheck')).toBe('false')
  // Loopback in tests: no acknowledgement is asked for.
  expect(within(form).queryByRole('checkbox')).toBeNull()
  fireEvent.change(input, { target: { value: KEY } })
  fireEvent.change(within(form).getByLabelText('Label (optional)'), { target: { value: 'work' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save key' }))
  await screen.findByText('OpenRouter is connected.')
  const post = calls.find((call) => call.path === '/api/settings/providers/openrouter/key')!
  expect(JSON.parse(post.init!.body as string)).toEqual({ apiKey: KEY, label: 'work' })
  expect(new Headers(post.init!.headers).get('Idempotency-Key')).toBeTruthy()
  expect(screen.queryByRole('form', { name: 'Add a key for OpenRouter' })).toBeNull()
  expect(document.body.innerHTML).not.toContain(KEY)
  // The terminal command was never fetched for a key provider.
  expect(calls.some((call) => call.path.endsWith('/connect'))).toBe(false)
})

test('a rejected key shows a generic message and clears the field', async () => {
  respondWith((path, init) =>
    path === '/api/settings/providers/openrouter/key' && init?.method === 'POST'
      ? json({ error: { code: 'not_verified', message: 'No' } }, 409)
      : undefined,
  )
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Add key OpenRouter' }))
  const form = await screen.findByRole('form', { name: 'Add a key for OpenRouter' })
  const input = within(form).getByLabelText('API key') as HTMLInputElement
  fireEvent.change(input, { target: { value: KEY } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save key' }))
  expect(await within(form).findByText(/Hermes did not accept that key/)).toBeDefined()
  expect(input.value).toBe('')
  expect(document.body.innerHTML).not.toContain(KEY)
  fireEvent.click(within(form).getByRole('button', { name: 'Use a terminal instead' }))
  respondWith(() => undefined)
})

test('over plain HTTP on a network address the key form warns and needs an acknowledgement', async () => {
  expect(crossesNetworkUnencrypted({ protocol: 'http:', hostname: '192.168.1.5' })).toBe(true)
  expect(crossesNetworkUnencrypted({ protocol: 'http:', hostname: 'localhost' })).toBe(false)
  expect(crossesNetworkUnencrypted({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(false)
  expect(crossesNetworkUnencrypted({ protocol: 'https:', hostname: 'score.lan' })).toBe(false)
  vi.stubGlobal('location', { ...window.location, protocol: 'http:', hostname: '192.168.1.5' })
  respondWith((path, init) =>
    path === '/api/settings/providers/openrouter/key' && init?.method === 'POST'
      ? json({ ...providers[0] })
      : undefined,
  )
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Add key OpenRouter' }))
  const form = await screen.findByRole('form', { name: 'Add a key for OpenRouter' })
  expect(within(form).getByRole('alert').textContent).toContain('not encrypted')
  fireEvent.change(within(form).getByLabelText('API key'), { target: { value: KEY } })
  const save = within(form).getByRole('button', { name: 'Save key' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  fireEvent.click(within(form).getByRole('checkbox', { name: /crosses my network unencrypted/ }))
  expect(save.disabled).toBe(false)
  fireEvent.click(save)
  await screen.findByText('OpenRouter is connected.')
  const post = calls.find((call) => call.path.endsWith('/key'))!
  expect(JSON.parse(post.init!.body as string)).toMatchObject({ acknowledgeInsecure: true })
})
