import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router'
import { afterEach, beforeEach, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { BoldRepeatingPage } from './BoldRepeating.tsx'

// Shared state, fixtures, fetch stub and mount for the Tasks › Repeating suites. Mocked responses only (decision 183).

class Source extends EventTarget {
  close() {}
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

const agent = (id: string, shape: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  role: '',
  style: { color: '#19C39A', shape },
  status: 'idle',
  activity: null,
  model: { id: 'demo-model', label: 'demo-model' },
  served: true,
  ...extra,
})
export const room = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder'],
  unread: 0,
  activeAgents: [],
  channels: [],
  ...extra,
})
export const job = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
  id,
  agentId,
  title: `Job ${id}`,
  schedule: '0 8 * * *',
  description: `Do ${id}`,
  lastRunAt: null,
  enabled: true,
  model: null,
  provider: null,
  nextRunAt: null,
  deliverTo: null,
  ...extra,
})

export const repeating = {
  jobs: [] as ReturnType<typeof job>[],
  unreadable: [] as string[],
  schedules: [] as Record<string, unknown>[],
  moveLeftBehind: null as string | null,
  fail: new Set<string>(),
  /** `METHOD path`s whose next request is lost on the way (a network error), once each. */
  drop: new Set<string>(),
  phone: false,
  wide: true,
  requests: [] as { method: string; path: string; body: unknown; key: string | null }[],
}
export const sent = (method: string, prefix = '/api/') =>
  repeating.requests.filter((item) => item.method === method && item.path.startsWith(prefix))

const disposers: (() => void)[] = []
const settings = {
  effort: null,
  fallbacks: [],
  fallbacksEditable: true,
  aliases: [{ name: 'deep', model: 'deep-model-1', provider: 'acme', editable: true }],
  speech: {
    stt: { provider: null, model: null },
    tts: { provider: null, model: null, voice: null },
  },
}
const listed = {
  items: [
    {
      provider: 'acme',
      providerLabel: 'Acme',
      model: 'acme-fast',
      available: true,
      reason: null,
      free: false,
      price: null,
    },
  ],
}

beforeEach(() => {
  Object.assign(repeating, {
    jobs: [],
    unreadable: [],
    schedules: [],
    moveLeftBehind: null,
    fail: new Set<string>(),
    drop: new Set<string>(),
    phone: false,
    wide: true,
    requests: [],
  })
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('1280px')
          ? repeating.wide
          : repeating.phone && query.includes('600px'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      const path = decodeURIComponent(url.pathname)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      const key = new Headers(init?.headers).get('Idempotency-Key')
      repeating.requests.push({ method, path, body, key })
      if (repeating.drop.delete(`${method} ${path}`))
        return Promise.reject(new TypeError('Failed to fetch'))
      if (method !== 'GET' && repeating.fail.has(`${method} ${path}`))
        return Promise.resolve(
          json({ error: { code: 'bad_request', message: 'Hermes said no.' } }, 400),
        )
      if (path === '/api/routines')
        return Promise.resolve(json({ items: repeating.jobs, unreadable: repeating.unreadable }))
      if (path === '/api/recipe-schedules')
        return Promise.resolve(json({ items: repeating.schedules }))
      if (/^\/api\/agents\/[^/]+\/assigned$/.test(path))
        return Promise.resolve(
          json({ agentId: path.split('/')[3], repeating: [], recipeSteps: [] }),
        )
      if (path === '/api/tasks')
        return Promise.resolve(
          json({
            asOfSeq: 1,
            columns: { planned: [], working: [], in_review: [], needs_you: [], done: [] },
          }),
        )
      if (path === '/api/agents')
        return Promise.resolve(
          json({
            asOfSeq: 1,
            items: [
              agent('builder', 'square'),
              agent('lead', 'hexagon'),
              agent('reviewer', 'triangle'),
              agent('coder', 'square', { runtime: 'codex' }),
            ],
          }),
        )
      if (path === '/api/rooms')
        return Promise.resolve(
          json({
            asOfSeq: 1,
            rooms: [room('room-a', 'Team room')],
            directs: [
              room('direct-builder', 'builder', {
                kind: 'direct',
                role: 'direct',
                members: ['builder'],
              }),
              room('direct-reviewer', 'reviewer', {
                kind: 'direct',
                role: 'direct',
                members: ['reviewer'],
              }),
            ],
            projects: [],
          }),
        )
      if (path.endsWith('/model-settings')) return Promise.resolve(json(settings))
      if (path === '/api/models') return Promise.resolve(json(listed))
      if (path === '/api/workflows')
        return Promise.resolve(
          json({
            items: [
              {
                id: 'wf1',
                name: 'Release notes',
                description: null,
                latestVersion: 1,
                versionCount: 1,
                used: false,
                agentIds: [],
                createdAt: '2026-11-01T00:00:00.000Z',
                updatedAt: '2026-11-01T00:00:00.000Z',
                activeRuns: 0,
                archivedAt: null,
              },
            ],
            inventory: {
              definitions: 1,
              versions: 1,
              bytes: 1,
              maxDefinitions: 200,
              maxVersionsPerDefinition: 20,
            },
          }),
        )
      if (method === 'POST' && path.endsWith('/move')) {
        const to = (body as { agentId: string }).agentId
        const old = repeating.jobs.find((item) => path.includes(`/${item.id}/`))!
        return Promise.resolve(
          json({
            job: { ...old, id: `${to}:moved`, agentId: to },
            leftBehind: repeating.moveLeftBehind,
          }),
        )
      }
      if (method === 'POST' && path.endsWith('/schedule/run'))
        return Promise.resolve(json({ ...repeating.schedules[0], lastRun: null }))
      if (method === 'POST' && path.endsWith('/routines'))
        return Promise.resolve(
          json(job('new', path.split('/')[3]!, body as Record<string, unknown>), 201),
        )
      if (method === 'PATCH') return Promise.resolve(json({ ...repeating.jobs[0], ...body }))
      if (method === 'POST' || method === 'DELETE') return Promise.resolve(json({}))
      return Promise.resolve(json({ error: { code: 'not_found', message: 'none' } }, 404))
    }),
  )
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

export function mount(entry = '/b/tasks/repeating', extra: RouteObject[] = []) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  disposers.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  const router = createMemoryRouter(
    [
      { path: '/b/tasks/repeating', Component: BoldRepeatingPage },
      ...extra,
      { path: '*', element: <p>elsewhere</p> },
    ],
    { initialEntries: [entry] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
  return router
}
