import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, vi } from 'vitest'
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

export class FakeNotification {
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
export const calls: { url: string; method: string; body: unknown }[] = []
let paused = false
let agentAccess = false
let memoryNotes = true

export const settingsState = {
  fenced: false,
  hermesTested: true,
  terminalOn: false,
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  calls.length = 0
  paused = false
  settingsState.fenced = false
  agentAccess = false
  memoryNotes = true
  settingsState.hermesTested = true
  settingsState.terminalOn = false
  FakeNotification.permission = 'granted'
  FakeNotification.shown = []
  FakeNotification.requestPermission.mockClear()
  vi.stubGlobal('Notification', FakeNotification)
  // jsdom has no scrolling; a section change scrolls to the top.
  vi.stubGlobal('scrollTo', vi.fn())
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
            tested: settingsState.hermesTested,
            disabled: settingsState.hermesTested ? [] : ['gateway-approvals'],
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
          terminal: settingsState.terminalOn,
          terminalUnavailable: null,
          unlockedUntil: new Date(Date.now() + 300_000).toISOString(),
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
          fenced: settingsState.fenced,
          reason: settingsState.fenced ? 'restore' : null,
          untrustedHistory: settingsState.fenced,
          revision: settingsState.fenced ? 1 : 2,
          since: settingsState.fenced ? '2026-10-24T09:00:00.000Z' : null,
          items: [],
          journal: { ok: true, entries: 4, bytes: 1200, sizeAlarm: false },
        })
      if (url.pathname === '/api/orchestrations/fence/lift' && method === 'POST') {
        settingsState.fenced = false
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
          items: settingsState.terminalOn
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
      if (url.pathname === '/api/workflows') return jsonResponse({ items: [] })
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

export function open(path = '/b/settings') {
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
