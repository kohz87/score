import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App, appRoutes } from '../App.tsx'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { immediateFrameScheduler, createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { jsonResponse, reportFixture } from '../test/reports-fixtures.ts'

class MockEventSource extends EventTarget {
  constructor(readonly url: string) {
    super()
  }
  close() {}
}

const rules = {
  mode: 'smart' as 'smart' | 'manual' | 'off',
  goAhead: [{ id: 'read', label: 'Read files', pattern: null, readOnly: false }],
  askMe: [{ id: 'install', label: 'Install packages', pattern: null, readOnly: false }],
  never: [{ id: 'never:secrets', label: 'secrets', pattern: 'secrets', readOnly: false }],
  drift: [],
}
const configItems = [
  {
    key: 'display.compact',
    value: false,
    file: 'config.yaml',
    description: 'Use a compact layout.',
  },
]
const browser = {
  id: '2b36f55a-8b37-4f55-a90e-18ecac49e7f2',
  label: 'Laptop',
  address: '127.0.0.1',
  createdAt: '2026-10-01T10:00:00.000Z',
  lastSeenAt: '2026-10-24T10:00:00.000Z',
  expiresAt: '2027-10-01T10:00:00.000Z',
  current: true,
}
const info = {
  vault: '/tmp/score-vault',
  notes: 3,
  gitAvailable: true,
  agentAccess: false,
  memoryNotes: true,
  documents: 2,
  documentBytes: 2048,
  moveIssue: null,
}

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => FakeNotification.permission)
  static shown: string[] = []
  onclick: (() => void) | null = null
  constructor(readonly title: string) {
    FakeNotification.shown.push(title)
  }
  close() {}
}

let router: ReturnType<typeof createMemoryRouter>
let registry: ReturnType<typeof createStreamQueryRegistry>
let stream: ReturnType<typeof createStreamClient>
let calls: { url: string; method: string; body: unknown }[]
let paused = false
let fenced = false
let agentAccess = false
let memoryNotes = true
let hermesTested = true

let terminalOn = false

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  calls = []
  paused = false
  fenced = false
  agentAccess = false
  memoryNotes = true
  hermesTested = true
  FakeNotification.permission = 'granted'
  FakeNotification.shown = []
  FakeNotification.requestPermission.mockClear()
  vi.stubGlobal('Notification', FakeNotification)
  Object.assign(window, { Notification: FakeNotification })
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: `${url.pathname}${url.search}`, method, body })

      if (url.pathname === '/api/agents')
        return jsonResponse({
          asOfSeq: 0,
          items: [
            {
              id: 'builder',
              name: 'builder',
              role: 'Builds features',
              style: { color: '#19C39A', shape: 'triangle' },
              status: 'idle',
              activity: null,
              model: { id: 'fake-model', label: 'Demo model' },
              served: true,
            },
          ],
        })
      if (url.pathname === '/api/agents/builder/runs-on')
        return jsonResponse({
          backend: 'docker',
          raw: 'docker',
          docker: {
            image: 'node:24',
            network: true,
            mountsWorkspace: true,
            runsAsRoot: false,
            extraMounts: 0,
          },
          ssh: null,
          separated: 'partly',
          separatedTools: [],
          hostTools: [],
          notes: [],
          checked: { how: 'live', hermes: '0.15.2', at: '2026-10-24T09:00:00.000Z' },
        })
      if (url.pathname === '/api/system')
        return jsonResponse({
          mode: 'fake',
          hermes: {
            version: '0.15.2',
            reachable: true,
            apiServer: true,
            capabilities: [],
            servedProfiles: [],
          },
          bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
          compatibility: {
            fingerprint: 'f',
            tested: hermesTested,
            disabled: hermesTested ? [] : ['gateway-approvals'],
          },
          agentIsolation: 'same_user',
          degraded: [],
        })
      if (url.pathname === '/api/settings/rules') {
        if (method === 'PUT' && url.searchParams.get('dryRun') === '1')
          return jsonResponse({ preview: '+mode: manual\n+never: rm -rf /tmp/*' })
        if (method === 'PUT') return jsonResponse({ ...rules, failed: [] })
        return jsonResponse(rules)
      }
      if (url.pathname === '/api/settings/config') return jsonResponse({ items: configItems })
      if (url.pathname === '/api/settings/providers')
        return jsonResponse({
          items: [
            {
              id: 'openrouter',
              label: 'OpenRouter',
              status: 'connected',
              detail: 'API key (1)',
              usedBy: [],
              signIn: 'api_key',
            },
          ],
        })
      if (url.pathname === '/api/settings/connections')
        return jsonResponse({
          toolServers: [{ id: 'files', label: 'files', status: 'ok', usedBy: 'everyone' }],
          messaging: [
            {
              platform: 'telegram',
              label: 'Telegram',
              status: 'connected',
              detail: null,
            },
          ],
        })
      if (url.pathname === '/api/triggers') return jsonResponse({ items: [] })
      if (url.pathname === '/api/themes')
        return jsonResponse({
          items: [
            {
              id: 'score',
              name: 'Score',
              version: '1.0.0',
              author: null,
              description: null,
              source: 'builtin',
              updatedAt: '2026-10-17T00:00:00.000Z',
              hasCss: false,
            },
          ],
          active: 'score',
          mode: 'system',
          resetGeneration: 0,
        })
      if (url.pathname === '/api/settings/currency') return jsonResponse({ code: 'USD', rate: 1 })
      if (url.pathname === '/api/settings/config/preview')
        return jsonResponse({
          diff: '+display.compact: true',
          file: 'config.yaml',
          hash: 'a'.repeat(64),
        })
      if (url.pathname === '/api/settings/config/apply')
        return jsonResponse({ ok: true, restartRequired: false })
      if (url.pathname === '/api/session/security')
        return jsonResponse({
          passwordSet: true,
          origins: ['https://score.test'],
          terminal: terminalOn,
          terminalUnavailable: null,
        })
      if (url.pathname === '/api/session/browsers') return jsonResponse({ items: [browser] })
      if (url.pathname === '/api/session/passkeys')
        return jsonResponse({ available: true, rpId: 'score.test', items: [] })
      if (url.pathname === '/api/now')
        return jsonResponse({
          asOfSeq: 0,
          now: '2026-10-24T10:00:00.000Z',
          paused,
          headline: { working: 0, needsYou: 0, text: 'Nobody is working.' },
          lanes: [],
          handoffs: [],
          focusApproval: null,
          thread: null,
          madeToday: [],
        })
      if (url.pathname === '/api/team/pause' || url.pathname === '/api/team/resume') {
        paused = url.pathname.endsWith('/pause')
        return jsonResponse({ paused, affectedRuns: 1 })
      }
      if (url.pathname === '/api/about')
        return jsonResponse({
          version: '1.14.0',
          commit: 'abc1234',
          schema: 12,
          contract: 10,
          hermes: { version: '0.15.2' },
          node: 'v24.0.0',
          mode: 'fake',
          repository: 'https://github.com/kohz87/score',
          checkout: '/tmp/score',
          service: false,
        })
      if (url.pathname === '/api/about/update-check')
        return jsonResponse({
          checkedAt: '2026-10-24T10:00:00.000Z',
          current: '1.14.0',
          status: 'up_to_date',
          latest: null,
          message: 'You’re up to date (v1.14.0).',
        })
      if (url.pathname === '/api/orchestrations/fence')
        return jsonResponse({
          fenced,
          reason: fenced ? 'restore' : null,
          untrustedHistory: fenced,
          revision: fenced ? 1 : 2,
          since: fenced ? '2026-10-24T09:00:00.000Z' : null,
          items: [],
          journal: { ok: true, entries: 4, bytes: 1200, sizeAlarm: false },
        })
      if (url.pathname === '/api/orchestrations/fence/lift' && method === 'POST') {
        fenced = false
        return jsonResponse({
          fenced: false,
          reason: null,
          untrustedHistory: false,
          revision: 2,
          since: null,
          items: [],
          journal: { ok: true, entries: 4, bytes: 1200, sizeAlarm: false },
        })
      }
      if (url.pathname === '/api/system/logs')
        return jsonResponse({
          available: true,
          items: [
            {
              time: '2026-10-24T10:00:00.000Z',
              level: 'info',
              message: 'approval requested',
              method: null,
              url: null,
              status: null,
              durationMs: null,
            },
          ],
        })
      if (url.pathname === '/api/knowledge')
        return jsonResponse({ ...info, agentAccess, memoryNotes })
      if (url.pathname === '/api/knowledge/agent-usage')
        return jsonResponse({ items: [{ agentId: 'builder', writesToday: 3 }] })
      if (url.pathname === '/api/knowledge/settings' && method === 'PUT') {
        if (body.agentAccess !== undefined) agentAccess = body.agentAccess === true
        if (body.memoryNotes !== undefined) memoryNotes = body.memoryNotes === true
        return jsonResponse({ ...info, agentAccess, memoryNotes })
      }
      if (url.pathname === '/api/shares') return jsonResponse({ items: [] })
      if (url.pathname === '/api/terminal/sessions' && method === 'DELETE') return jsonResponse({})
      if (url.pathname === '/api/terminal/sessions')
        return jsonResponse({
          items: terminalOn
            ? [
                {
                  id: '3f1c6a52-1b7e-4c1c-9a53-0d5c1a2b3c4d',
                  cols: 80,
                  rows: 24,
                  openedAt: '2026-10-26T10:00:00.000Z',
                  lastActivityAt: '2026-10-26T10:05:00.000Z',
                  address: '10.0.0.5',
                },
              ]
            : [],
        })
      if (url.pathname === '/api/reports') return jsonResponse(reportFixture('7d'))
      return jsonResponse({ error: { code: 'not_found', message: 'No' } }, 404)
    }),
  )
})

afterEach(() => {
  cleanup()
  router.dispose()
  registry.dispose()
  stream.close()
  vi.unstubAllGlobals()
})

function open(path = '/b/settings') {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  stream = createStreamClient({ EventSourceImpl: MockEventSource as never })
  registry = createStreamQueryRegistry(queryClient, stream, immediateFrameScheduler)
  router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream, queries: registry }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
  return router
}

test('the nine Settings sections open their bold views, including Connections, Tools and Look', async () => {
  open('/b/settings/connections')
  expect(await screen.findByRole('heading', { name: 'Connections' })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Hermes' })).toBeDefined()
  expect(await screen.findByText('OpenRouter')).toBeDefined()
  expect(await screen.findByText('Telegram')).toBeDefined()
  const nav = screen.getByRole('navigation', { name: 'Settings' })
  fireEvent.click(within(nav).getByRole('button', { name: /^Tools and triggers/ }))
  expect(await screen.findByRole('heading', { name: 'Tools and triggers' })).toBeDefined()
  expect(await screen.findByText('files')).toBeDefined()
  expect(screen.getByRole('button', { name: 'New trigger' })).toBeDefined()
  fireEvent.click(within(nav).getByRole('button', { name: /^Look/ }))
  expect(await screen.findByRole('heading', { name: 'Look' })).toBeDefined()
  expect(screen.getByRole('radiogroup', { name: 'Mode on this device' })).toBeDefined()
  expect(screen.getByRole('slider', { name: 'Text size' })).toBeDefined()
  fireEvent.click(within(nav).getByRole('button', { name: /^Rules/ }))
  expect(await screen.findByRole('heading', { name: 'Rules' })).toBeDefined()
  fireEvent.click(within(nav).getByRole('button', { name: /^Notifications/ }))
  expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeDefined()
  fireEvent.click(within(nav).getByRole('button', { name: /^Remote access and security/ }))
  expect(await screen.findByRole('heading', { name: 'Remote access and security' })).toBeDefined()
  fireEvent.click(within(nav).getByRole('button', { name: /^Advanced/ }))
  expect(await screen.findByRole('heading', { name: 'Advanced' })).toBeDefined()
  fireEvent.click(within(nav).getByRole('button', { name: /^System/ }))
  expect(await screen.findByRole('heading', { name: 'System' })).toBeDefined()
})

test('Rules stages a mode and a Never rule, reviews the diff, then saves for the team', async () => {
  open('/b/settings/rules')
  const region = await screen.findByRole('region', { name: 'Rules' })
  expect(region.getAttribute('data-protected')).toBe('block')
  expect(within(region).getByRole('group', { name: 'Go ahead' })).toBeDefined()
  fireEvent.click(within(region).getByRole('radio', { name: /Always ask me/ }))
  fireEvent.click(within(region).getByRole('button', { name: 'Add a rule' }))
  const never = within(region).getByRole('form', { name: 'Add a Never rule' })
  fireEvent.change(within(never).getByLabelText(/Never allow commands that match/), {
    target: { value: 'rm   -rf /tmp/*' },
  })
  fireEvent.click(within(never).getByRole('button', { name: 'Add to Never' }))
  expect(within(region).getByRole('group', { name: 'Never' }).textContent).toContain(
    'rm -rf /tmp/*',
  )
  fireEvent.click(within(region).getByRole('button', { name: 'Review changes' }))
  expect(await within(region).findByLabelText('Changes')).toHaveProperty(
    'textContent',
    expect.stringContaining('+never: rm -rf /tmp/*'),
  )
  fireEvent.click(within(region).getByRole('button', { name: 'Save for the whole team' }))
  expect(await within(region).findByText('Saved for the whole team.')).toBeDefined()
  expect(
    calls.filter((call) => call.url === '/api/settings/rules' && call.method === 'PUT').at(-1)
      ?.body,
  ).toEqual({ mode: 'manual', goAhead: ['read'], never: ['secrets', 'rm -rf /tmp/*'] })
})

test('Notifications asks for permission on the click, then remembers the chosen kinds', async () => {
  open('/b/settings/notifications')
  expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeDefined()
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Turn on notifications on this device' }))
  expect(
    await screen.findByRole('button', { name: 'Turn off notifications on this device' }),
  ).toBeDefined()
  const kind = screen.getByRole('checkbox', {
    name: /An approval is waiting for me/,
  }) as HTMLInputElement
  expect(kind.disabled).toBe(false)
  fireEvent.click(kind)
  expect(JSON.parse(window.localStorage.getItem('score.notifications')!)).toMatchObject({
    enabled: true,
    kinds: { approvals: false },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send a test notification' }))
  await waitFor(() => expect(FakeNotification.shown).toContain('Score notifications work'))
})

test('Remote access and security keeps the protected password, browsers and passkey surfaces', async () => {
  open('/b/settings/security')
  expect(await screen.findByRole('heading', { name: 'Remote access and security' })).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Where agents run' })).toBeDefined()
  const where = await screen.findByRole('list', { name: 'Where agents run' })
  expect(where.textContent).toContain('builder')
  expect(where.textContent).toContain('Docker · node:24')
  expect(where.textContent).toContain('Partly separated')
  expect(within(where).getByRole('link', { name: 'Runs on' }).getAttribute('href')).toBe(
    '/b/team/builder#agent-where',
  )
  const remote = document.querySelector('#remote-access')!
  expect(remote.getAttribute('data-protected')).toBe('flex')
  expect(remote.getAttribute('data-decision')).not.toBeNull()
  expect(await screen.findByRole('list', { name: 'Paired browsers' })).toHaveProperty(
    'textContent',
    expect.stringContaining('Laptop'),
  )
  expect(screen.getByRole('button', { name: 'Log out this browser' })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Passkeys' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'Open the terminal' }).getAttribute('href')).toBe(
    '/terminal',
  )
})

test('Advanced searches, stages, previews and applies a Hermes setting', async () => {
  open('/b/settings/advanced')
  expect(await screen.findByRole('heading', { name: 'Advanced' })).toBeDefined()
  const search = screen.getByRole('searchbox', { name: 'Search settings' })
  fireEvent.change(search, { target: { value: 'display.compact' } })
  expect(await screen.findByText('display.compact')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Edit display.compact' }))
  fireEvent.change(screen.getByLabelText('New value for display.compact'), {
    target: { value: 'true' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add change' }))
  const tray = screen.getByRole('group', { name: 'Pending changes' })
  expect(tray.textContent).toContain('display.compact = true')
  expect(within(tray).getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true)
  fireEvent.click(within(tray).getByRole('button', { name: 'Preview' }))
  expect(await within(tray).findByLabelText('Changes preview')).toHaveProperty(
    'textContent',
    expect.stringContaining('+display.compact: true'),
  )
  fireEvent.click(within(tray).getByRole('button', { name: 'Apply' }))
  expect(await screen.findByText(/Saved\./)).toBeDefined()
})

test('the Hermes version banner sits above every bold section and keeps its protected mark', async () => {
  hermesTested = false
  open('/b/settings/notifications')
  const banner = await screen.findByRole('region', { name: 'Hermes was updated' })
  expect(banner.getAttribute('data-protected')).toBe('block')
  expect(within(banner).getByRole('button', { name: 'Check this Hermes version' })).toBeDefined()
  const nav = screen.getByRole('navigation', { name: 'Settings' })
  fireEvent.click(within(nav).getByRole('button', { name: /^System/ }))
  expect(await screen.findByRole('heading', { name: 'System' })).toBeDefined()
  expect(screen.getByRole('region', { name: 'Hermes was updated' })).toBe(banner)
})

test('System shows service, updates, backups, logs, Library access, Shares, Terminal and Pause everyone', async () => {
  open('/b/settings/system')
  expect(await screen.findByRole('heading', { name: 'System' })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Score' })).toBeDefined()
  expect(await screen.findByText('Score v1.14.0')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
  expect(await screen.findByText(/You’re up to date/)).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Backups' })).toBeDefined()
  expect(screen.getByText(/scripts\/score restore/)).toBeDefined()
  expect(await screen.findByText('approval requested')).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Shares' })).toBeDefined()
  expect(screen.getByText('No share links yet. Make one from a room’s menu in Chat.')).toBeDefined()
  const facts = screen.getByText('Knowledge folder').closest('dl')!
  expect(facts.textContent).toContain('/tmp/score-vault')
  expect(facts.textContent).toContain('2 files, 2 KB')
  expect(facts.textContent).toContain('Versioned with git: every save is a commit.')
  expect(await screen.findByText('Agent writes today')).toBeDefined()
  expect(screen.getByText('builder')).toBeDefined()
  expect(screen.getByText('3 writes')).toBeDefined()
  const library = (await screen.findByRole('switch', {
    name: 'Agents can use Library',
  })) as HTMLInputElement
  expect(library.checked).toBe(false)
  fireEvent.click(library)
  await waitFor(() =>
    expect(
      calls.some((call) => call.url === '/api/knowledge/settings' && call.method === 'PUT'),
    ).toBe(true),
  )
  await waitFor(() => expect(library.checked).toBe(true))
  const memory = screen.getByRole('switch', {
    name: 'Save compacted summaries as memory notes',
  }) as HTMLInputElement
  expect(memory.checked).toBe(true)
  fireEvent.click(memory)
  await waitFor(() =>
    expect(
      calls.filter((call) => call.url === '/api/knowledge/settings' && call.method === 'PUT').at(-1)
        ?.body,
    ).toEqual({ memoryNotes: false }),
  )
  await waitFor(() =>
    expect(
      (
        screen.getByRole('switch', {
          name: 'Save compacted summaries as memory notes',
        }) as HTMLInputElement
      ).checked,
    ).toBe(false),
  )
  expect(screen.getByRole('link', { name: 'Open the terminal' }).getAttribute('href')).toBe(
    '/terminal',
  )
  expect(screen.getByRole('link', { name: 'Open Library' }).getAttribute('href')).toBe(
    '/b?library=1',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Pause everyone' }))
  expect(await screen.findByRole('button', { name: 'Resume everyone' })).toBeDefined()
})

test('System shows the fence review in Backups, and lifting it removes the review', async () => {
  fenced = true
  open('/b/settings/system')
  expect(
    await screen.findByRole('heading', {
      name: 'Starting work is blocked until you review this list',
    }),
  ).toBeDefined()
  expect(screen.getByText(/No orchestration starts anything new/)).toBeDefined()
  fireEvent.click(screen.getByRole('checkbox', { name: /I’ve been through this list/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Lift the block' }))
  await waitFor(() =>
    expect(
      screen.queryByRole('heading', {
        name: 'Starting work is blocked until you review this list',
      }),
    ).toBeNull(),
  )
  expect(screen.getByText(/Nothing is blocked/)).toBeDefined()
  expect(fenced).toBe(false)
})

test('the Customizer page marks the Settings frame as a section page (phone: the list steps aside)', async () => {
  open('/b/settings/look/customize')
  expect(await screen.findByRole('button', { name: /All settings/ })).toBeDefined()
  expect(document.querySelector('.setgrid[data-section-page]')).toBeTruthy()
  open('/b/settings/look')
  expect(await screen.findByRole('heading', { name: 'Look' })).toBeDefined()
})

test('Remote access and security lists open terminals and closes one', async () => {
  terminalOn = true
  try {
    open('/b/settings/security')
    const list = await screen.findByRole('list', { name: 'Open terminals' })
    expect(await within(list).findByText(/from 10\.0\.0\.5/)).toBeDefined()
    fireEvent.click(within(list).getByRole('button', { name: 'Close' }))
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([url, init]) =>
              String(url) === '/api/terminal/sessions/3f1c6a52-1b7e-4c1c-9a53-0d5c1a2b3c4d' &&
              (init as RequestInit | undefined)?.method === 'DELETE',
          ),
      ).toBe(true),
    )
  } finally {
    terminalOn = false
  }
})
