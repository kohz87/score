import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { BoldTasksPage } from './BoldTasks.tsx'

class Source extends EventTarget {
  close() {}
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
export const at = (minutes: number) =>
  new Date(Date.UTC(2026, 10, 2, 12, 0) - minutes * 60_000).toISOString()

const agent = (id: string, color: string, shape: string) => ({
  id,
  name: id,
  role: '',
  style: { color, shape },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
})
const agents = [
  agent('builder', '#19C39A', 'square'),
  agent('lead', '#6B4EFF', 'hexagon'),
  agent('reviewer', '#FFB61E', 'triangle'),
]
export const room = (id: string, name: string) => ({
  id,
  name,
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder'],
  unread: 0,
  activeAgents: [],
  channels: [],
})

export function task(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    key: id.toUpperCase(),
    title: `Task ${id}`,
    column: 'working',
    hermesStatus: 'running',
    assignee: 'builder',
    reviewer: 'reviewer',
    roomId: 'room-a',
    badge: null,
    progress: null,
    elapsedSec: 840,
    note: null,
    updatedAt: at(5),
    ...patch,
  }
}

export const detailOf = (
  summary: Record<string, unknown>,
  patch: Record<string, unknown> = {},
) => ({
  ...summary,
  body: '',
  createdBy: 'lead',
  steps: [
    { id: 's1', text: 'Reproduce it', done: true },
    { id: 's2', text: 'Fix it', done: false },
  ],
  activity: [{ at: at(3), agentId: 'builder', text: 'Started on the fix' }],
  pendingApproval: null,
  dependsOn: [],
  blocks: [],
  runIds: [],
  ...patch,
})

type Task = ReturnType<typeof task>
type Room = ReturnType<typeof room>

export const boldTasksState = {
  tasks: [] as Task[],
  details: {} as Record<string, unknown>,
  rooms: [] as Room[],
  narrow: false,
  createFails: 0,
  phone: false,
  requests: [] as { url: string; init?: RequestInit }[],
}

const disposers: (() => void)[] = []

const columnsOf = () => {
  const columns: Record<string, unknown[]> = {
    planned: [],
    working: [],
    in_review: [],
    needs_you: [],
    done: [],
  }
  for (const item of boldTasksState.tasks) columns[item.column as string]!.push(item)
  return columns
}

beforeEach(() => {
  boldTasksState.tasks = []
  boldTasksState.details = {}
  boldTasksState.rooms = [room('room-a', 'Feed team')]
  boldTasksState.phone = false
  boldTasksState.narrow = false
  boldTasksState.createFails = 0
  boldTasksState.requests = []
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('1280px')
          ? !boldTasksState.narrow
          : boldTasksState.phone && query.includes('600px'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      boldTasksState.requests.push({ url, ...(init ? { init } : {}) })
      if (url === '/api/tasks' && init?.method === 'POST') {
        if (boldTasksState.createFails > 0) {
          boldTasksState.createFails -= 1
          return Promise.resolve(
            json({ error: { code: 'bad_request', message: 'No such chat.' } }, 400),
          )
        }
        return Promise.resolve(json(detailOf(task('t-new', { title: 'Brand new' })), 201))
      }
      if (url === '/api/tasks') return Promise.resolve(json({ asOfSeq: 1, columns: columnsOf() }))
      if (url === '/api/agents') return Promise.resolve(json({ asOfSeq: 1, items: agents }))
      if (url === '/api/rooms')
        return Promise.resolve(
          json({ asOfSeq: 1, rooms: boldTasksState.rooms, directs: [], projects: [] }),
        )
      const id = /^\/api\/tasks\/([^/]+)$/.exec(url)?.[1]
      if (id && boldTasksState.details[id]) return Promise.resolve(json(boldTasksState.details[id]))
      if (url.includes('/actions') || url.includes('/decision'))
        return Promise.resolve(json(url.includes('/decision') ? approval('once') : { ok: true }))
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

export const approval = (choice?: string) => ({
  id: 'ap-1',
  origin: 'kanban',
  phase: choice ? 'decided' : 'human_pending',
  status: choice ? 'approved' : 'pending',
  actionable: !choice,
  linkedTo: null,
  agentId: 'builder',
  title: 'Run the migration',
  command: 'pnpm migrate',
  cwd: null,
  description: '',
  choices: ['once', 'deny'],
  createdAt: at(2),
  expiresAt: null,
  decision: choice ? { choice, by: 'you', at: at(1) } : null,
  delivery: choice ? 'intent' : 'none',
  blocking: null,
  refs: [],
})

export function mount() {
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
      { path: '/b/tasks', Component: BoldTasksPage },
      { path: '*', element: <p>elsewhere</p> },
    ],
    { initialEntries: ['/b/tasks'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}

export const column = (name: string) => screen.getByRole('region', { name })
export const posts = () => boldTasksState.requests.filter((item) => item.init?.method === 'POST')
