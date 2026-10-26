import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, ConnectionsResponse, ProviderItem } from '@score/contract'
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
function mount(path = '/settings') {
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
  document.documentElement.removeAttribute('data-theme')
  cleanup()
  router.dispose()
  registry.dispose()
  stream.close()
  vi.unstubAllGlobals()
})

const slackFields = {
  browserSetup: true,
  fields: [
    {
      key: 'SLACK_BOT_TOKEN',
      label: 'Bot token (xoxb-)',
      help: 'Copy the Bot User OAuth Token.',
      url: 'https://api.slack.com/apps',
      secret: true,
      required: true,
    },
    {
      key: 'SLACK_ALLOWED_USERS',
      label: 'Allowed member IDs',
      help: null,
      url: null,
      secret: false,
      required: false,
    },
  ],
}
function messagingRespond(put: () => Response) {
  const base = respond
  respond = (path, init) => {
    if (path === '/api/settings/messaging/slack/fields') return json(slackFields)
    if (path === '/api/settings/messaging/slack' && init?.method === 'PUT') return put()
    return base(path, init)
  }
}
test('messaging setup: a form from the field metadata, secret toggle, save, restart note', async () => {
  messagingRespond(() =>
    json({ platform: 'slack', label: 'Slack', status: 'disconnected', detail: null }),
  )
  mount('/settings/connections')
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Slack' }))
  const form = await screen.findByRole('form', { name: 'Connect Slack' })
  const token = within(form).getByLabelText(/Bot token/, { selector: 'input' }) as HTMLInputElement
  expect(token.type).toBe('password')
  expect(within(form).getByText('Copy the Bot User OAuth Token.')).toBeDefined()
  expect(within(form).getByRole('link', { name: 'Where to get it' }).getAttribute('href')).toBe(
    'https://api.slack.com/apps',
  )
  fireEvent.click(within(form).getByRole('button', { name: 'Show Bot token (xoxb-)' }))
  expect(token.type).toBe('text')
  fireEvent.change(token, { target: { value: 'xoxb-secret' } })
  fireEvent.change(within(form).getByLabelText(/Allowed member IDs/), { target: { value: '  ' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
  expect(await screen.findByText(/Saved\. The gateway picks up/)).toBeDefined()
  const put = calls.find((call) => call.init?.method === 'PUT')!
  expect(put.path).toBe('/api/settings/messaging/slack')
  expect(JSON.parse(String(put.init!.body))).toEqual({ values: { SLACK_BOT_TOKEN: 'xoxb-secret' } })
  expect(document.body.textContent).not.toContain('xoxb-secret')
})
test('messaging setup: a failed save shows an error and clears the token', async () => {
  messagingRespond(() => json({ error: { code: 'not_paired', message: 'x' } }, 401))
  mount('/settings/connections')
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Slack' }))
  const form = await screen.findByRole('form', { name: 'Connect Slack' })
  const token = within(form).getByLabelText(/Bot token/, { selector: 'input' }) as HTMLInputElement
  fireEvent.change(token, { target: { value: 'xoxb-secret' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
  expect(await within(form).findByText(/Pair this browser/)).toBeDefined()
  expect(token.value).toBe('')
})
test('messaging setup: a pairing platform explains that it needs the terminal', async () => {
  const base = respond
  respond = (path, init) =>
    path === '/api/settings/messaging/slack/fields'
      ? json({ fields: [], browserSetup: false })
      : base(path, init)
  mount('/settings/connections')
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Slack' }))
  expect(await screen.findByText(/This one needs the terminal/)).toBeDefined()
  expect(screen.getByText('hermes gateway setup')).toBeDefined()
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
  fireEvent.click(within(advanced).getByRole('button', { name: 'Add change' }))
  return advanced
}

test('advanced: collapsed by default, opens on click or on a search, and remembers the choice', async () => {
  window.localStorage.clear()
  advancedRespond(() => json({ ok: true, restartRequired: false }))
  mount('/settings/advanced')
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
  mount('/settings/advanced')
  expect(await screen.findByRole('list', { name: 'Settings' })).toBeDefined()
  window.localStorage.clear()
})

test('advanced: while a search is on its way only matching settings show, never the whole list (5.23)', async () => {
  advancedRespond(() => json({ ok: true, restartRequired: false }))
  const base = respond
  respond = (path, init) =>
    path.startsWith('/api/settings/config?q=turn')
      ? (new Promise<Response>(() => undefined) as unknown as Response)
      : base(path, init)
  mount('/settings/advanced')
  const advanced = await screen.findByRole('region', { name: 'Advanced' })
  await within(advanced).findByRole('button', { name: 'Show all 2 settings' })
  fireEvent.change(within(advanced).getByRole('searchbox', { name: 'Search settings' }), {
    target: { value: 'turn' },
  })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const list = within(advanced).getByRole('list', { name: 'Settings' })
  expect(within(list).getByText('agent.max_turns')).toBeDefined()
  expect(within(list).queryByText('display.language')).toBeNull()
})

test('advanced: blocked storage still opens the list', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  advancedRespond(() => json({ ok: true, restartRequired: false }))
  mount('/settings/advanced')
  fireEvent.click(await screen.findByRole('button', { name: 'Show all 2 settings' }))
  expect(screen.getByRole('list', { name: 'Settings' })).toBeDefined()
  vi.restoreAllMocks()
})

test('advanced: search, stage a change, preview the diff, then apply with the hash', async () => {
  advancedRespond(() => json({ ok: true, restartRequired: true }))
  mount('/settings/advanced')
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
  mount('/settings/advanced')
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
  mount('/settings/advanced')
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
  mount('/settings/advanced')
  const advanced = await stageTurns()
  fireEvent.click(within(advanced).getByRole('button', { name: 'Preview' }))
  await within(advanced).findByText(/\+agent.max_turns: 30/)
  fireEvent.click(within(advanced).getByRole('button', { name: 'Apply' }))
  fireEvent.click(within(advanced).getByRole('button', { name: 'Edit display.language' }))
  fireEvent.change(within(advanced).getByLabelText('New value for display.language'), {
    target: { value: 'fr' },
  })
  fireEvent.click(within(advanced).getByRole('button', { name: 'Add change' }))
  release()
  await within(advanced).findByText(/Saved\./)
  const tray = within(advanced).getByRole('group', { name: 'Pending changes' })
  expect(within(tray).getByText(/display.language = fr/)).toBeDefined()
  expect(within(tray).queryByText(/agent.max_turns/)).toBeNull()
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
