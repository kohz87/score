import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { BoldTasksPage } from './BoldTasks.tsx'

class Source extends EventTarget {
  close() {}
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const at = (minutes: number) =>
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
const room = (id: string, name: string) => ({
  id,
  name,
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder'],
  unread: 0,
  activeAgents: [],
  channels: [],
})

function task(id: string, patch: Record<string, unknown> = {}) {
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

const detailOf = (summary: Record<string, unknown>, patch: Record<string, unknown> = {}) => ({
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

let tasks: ReturnType<typeof task>[]
let details: Record<string, unknown>
let rooms: ReturnType<typeof room>[]
let phone = false
let requests: { url: string; init?: RequestInit }[]
const disposers: (() => void)[] = []

const columnsOf = () => {
  const columns: Record<string, unknown[]> = {
    planned: [],
    working: [],
    in_review: [],
    needs_you: [],
    done: [],
  }
  for (const item of tasks) columns[item.column as string]!.push(item)
  return columns
}

beforeEach(() => {
  tasks = []
  details = {}
  rooms = [room('room-a', 'Feed team')]
  phone = false
  requests = []
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: phone && query.includes('600px'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, ...(init ? { init } : {}) })
      if (url === '/api/tasks') return Promise.resolve(json({ asOfSeq: 1, columns: columnsOf() }))
      if (url === '/api/agents') return Promise.resolve(json({ asOfSeq: 1, items: agents }))
      if (url === '/api/rooms')
        return Promise.resolve(json({ asOfSeq: 1, rooms, directs: [], projects: [] }))
      const id = /^\/api\/tasks\/([^/]+)$/.exec(url)?.[1]
      if (id && details[id]) return Promise.resolve(json(details[id]))
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

const approval = (choice?: string) => ({
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

function mount() {
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

const column = (name: string) => screen.getByRole('region', { name })
const posts = () => requests.filter((item) => item.init?.method === 'POST')

test('five columns with counts, cards with key, room, badge, progress and agent', async () => {
  tasks = [
    task('t1', { progress: 0.6 }),
    task('t2', {
      column: 'planned',
      elapsedSec: null,
      badge: { kind: 'starts_after', label: 'Starts after T-1' },
    }),
    task('t3', { column: 'in_review' }),
    task('t4', {
      column: 'needs_you',
      hermesStatus: 'blocked',
      badge: { kind: 'blocked', label: 'Needs a token' },
    }),
    task('t5', { column: 'done', roomId: null }),
  ]
  details.t1 = detailOf(tasks[0]!)
  mount()
  await screen.findByRole('button', { name: 'T1 Task t1' })
  for (const [name, count] of [
    ['Planned', '1'],
    ['Working', '1'],
    ['In review', '1'],
    ['Needs you', '1'],
    ['Done', '1'],
  ] as const)
    expect(within(column(name)).getByRole('heading').textContent).toContain(count)
  const card = screen.getByRole('button', { name: 'T1 Task t1' })
  expect(card.textContent).toContain('Feed team')
  expect(card.textContent).toContain('14 min')
  expect(within(card).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('60')
  expect(screen.getByRole('button', { name: 'T2 Task t2' }).textContent).toContain(
    'Starts after T-1',
  )
  expect(screen.getByRole('button', { name: 'T5 Task t5' }).textContent).toContain('No room')
  const needs = screen.getByRole('button', { name: 'T4 Task t4' })
  expect(needs.hasAttribute('data-protected')).toBe(true)
  expect(screen.getByText('1 need you').hasAttribute('data-protected')).toBe(true)
})

test('filters by agent, and shows the room filter only across two rooms', async () => {
  tasks = [task('t1'), task('t2', { assignee: 'lead' })]
  mount()
  await screen.findByRole('button', { name: 'T1 Task t1' })
  expect(screen.queryByRole('group', { name: 'Filter by room' })).toBeNull()
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Filter by agent' })).getByRole('button', {
      name: 'lead',
    }),
  )
  expect(screen.queryByRole('button', { name: 'T1 Task t1' })).toBeNull()
  expect(screen.getByRole('button', { name: 'T2 Task t2' })).toBeTruthy()
  expect(within(column('Planned')).getByText('Nothing here for this filter.')).toBeTruthy()
})

test('filters by room when tasks span two rooms', async () => {
  rooms = [room('room-a', 'Feed team'), room('room-b', 'Billing team')]
  tasks = [task('t1'), task('t2', { roomId: 'room-b' })]
  mount()
  await screen.findByRole('button', { name: 'T1 Task t1' })
  const filter = screen.getByRole('group', { name: 'Filter by room' })
  fireEvent.click(within(filter).getByRole('button', { name: 'Billing team' }))
  expect(screen.queryByRole('button', { name: 'T1 Task t1' })).toBeNull()
  expect(screen.getByRole('button', { name: 'T2 Task t2' })).toBeTruthy()
})

test('Done lists the 20 newest and "Show older" the rest', async () => {
  tasks = Array.from({ length: 23 }, (_, index) =>
    task(`d${String(index).padStart(2, '0')}`, { column: 'done', updatedAt: at(index + 1) }),
  )
  mount()
  await screen.findByRole('button', { name: 'D00 Task d00' })
  expect(within(column('Done')).getAllByRole('button', { name: /^D\d\d/ })).toHaveLength(20)
  fireEvent.click(screen.getByRole('button', { name: 'Show older (3)' }))
  expect(within(column('Done')).getAllByRole('button', { name: /^D\d\d/ })).toHaveLength(23)
})

test('the panel shows the task, its steps and comments, and Comment posts', async () => {
  tasks = [task('t1')]
  details.t1 = detailOf(tasks[0]!)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'T1 Task t1' }))
  const panel = screen.getByRole('complementary', { name: 'Task details' })
  await within(panel).findByText('Reproduce it')
  expect(panel.textContent).toContain('Hermes: running')
  expect(within(panel).getByRole('link', { name: 'Feed team' })).toBeTruthy()
  expect(within(panel).getByText('Started on the fix')).toBeTruthy()
  fireEvent.change(within(panel).getByLabelText(/Add a comment for builder/), {
    target: { value: 'Check the edge case' },
  })
  fireEvent.click(within(panel).getByRole('button', { name: 'Comment' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(posts()[0]!.url).toBe('/api/tasks/t1/actions')
  expect(JSON.parse(String(posts()[0]!.init!.body))).toEqual({
    action: 'comment',
    text: 'Check the edge case',
  })
})

test('a blocked task shows Unblock in a light protected block', async () => {
  tasks = [
    task('t4', {
      column: 'needs_you',
      hermesStatus: 'blocked',
      badge: { kind: 'blocked', label: 'Needs a token' },
    }),
  ]
  details.t4 = detailOf(tasks[0]!)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'T4 Task t4' }))
  const block = await screen.findByLabelText('Needs you', { selector: 'div' })
  expect(block.hasAttribute('data-protected')).toBe(true)
  expect(within(block).getByRole('link', { name: 'Open in its room' })).toBeTruthy()
  expect(block.textContent).toContain('Needs a token')
  fireEvent.click(within(block).getByRole('button', { name: 'Unblock' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(JSON.parse(String(posts()[0]!.init!.body))).toEqual({ action: 'unblock' })
  await within(block).findByText('Sent — waiting for Hermes')
})

test('a pending approval is approved from the panel', async () => {
  tasks = [task('t6', { column: 'needs_you', badge: { kind: 'needs_you', label: 'Approval' } })]
  details.t6 = detailOf(tasks[0]!, { pendingApproval: approval() })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'T6 Task t6' }))
  const allow = await screen.findByRole('button', { name: 'Allow' })
  expect(screen.getByText('pnpm migrate')).toBeTruthy()
  fireEvent.click(allow)
  await waitFor(() => expect(posts()).toHaveLength(1))
  expect(posts()[0]!.url).toBe('/api/approvals/ap-1/decision')
  expect(JSON.parse(String(posts()[0]!.init!.body))).toEqual({ choice: 'once' })
})

test('on a phone Needs you comes first with its actions, then the column tabs, and a card opens a sheet', async () => {
  phone = true
  tasks = [
    task('t1'),
    task('t3', { column: 'planned' }),
    task('t4', {
      column: 'needs_you',
      hermesStatus: 'blocked',
      badge: { kind: 'blocked', label: 'Needs a token' },
    }),
  ]
  details.t1 = detailOf(tasks[0]!)
  mount()
  const needs = await screen.findByRole('region', { name: 'Needs you' })
  expect(within(needs).getByRole('button', { name: 'Unblock' })).toBeTruthy()
  const tabs = screen.getByRole('tablist', { name: 'Columns' })
  expect(
    within(tabs)
      .getAllByRole('tab')
      .map((tab) => tab.textContent?.split(' ')[0]),
  ).toEqual(['Working', 'Planned', 'In', 'Done'])
  expect(needs.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(within(needs).getByRole('button', { name: 'Unblock' }))
  await waitFor(() => expect(posts()).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: 'T1 Task t1' }))
  const sheet = await screen.findByRole('dialog', { name: 'Task details' })
  await within(sheet).findByText('Reproduce it')
  fireEvent.click(within(sheet).getByRole('button', { name: 'Close task details' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('empty states: no tasks at all, and a filter with nothing', async () => {
  mount()
  expect(
    await screen.findByText(/No tasks yet\. Hermes tasks your agents create show up here\./),
  ).toBeTruthy()
  expect(screen.queryByRole('group', { name: 'Filter by agent' })).toBeNull()
})

// Review (3.16.0): the panel's state belongs to one task, and a phone card only unblocks a blocked task.
test('switching tasks starts a fresh panel: one task’s Unblock or draft never carries to the next', async () => {
  tasks = [
    task('t4', {
      column: 'needs_you',
      hermesStatus: 'blocked',
      badge: { kind: 'blocked', label: 'Needs a token' },
    }),
    task('t5', {
      column: 'needs_you',
      hermesStatus: 'blocked',
      badge: { kind: 'blocked', label: 'Needs a key' },
    }),
  ]
  details.t4 = detailOf(tasks[0]!)
  details.t5 = detailOf(tasks[1]!)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'T4 Task t4' }))
  const first = await screen.findByLabelText('Needs you', { selector: 'div' })
  fireEvent.click(within(first).getByRole('button', { name: 'Unblock' }))
  await within(first).findByText('Sent — waiting for Hermes')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'half a thought' } })
  fireEvent.click(screen.getByRole('button', { name: 'T5 Task t5' }))
  const second = await screen.findByLabelText('Needs you', { selector: 'div' })
  await within(second).findByText('Needs a key')
  const unblock = within(second).getByRole('button', { name: 'Unblock' }) as HTMLButtonElement
  expect(unblock.disabled).toBe(false)
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
})

test('on a phone a task waiting on an approval offers Review and decide, never Unblock', async () => {
  phone = true
  // As the server sends it: an approval moves the task to Needs you and leaves Hermes' status and badge alone.
  tasks = [task('t6', { column: 'needs_you', hermesStatus: 'running', badge: null })]
  details.t6 = detailOf(tasks[0]!, { pendingApproval: approval() })
  mount()
  const needs = await screen.findByRole('region', { name: 'Needs you' })
  expect(within(needs).queryByRole('button', { name: 'Unblock' })).toBeNull()
  fireEvent.click(within(needs).getByRole('button', { name: 'Review and decide' }))
  const sheet = await screen.findByRole('dialog', { name: 'Task details' })
  expect(await within(sheet).findByRole('button', { name: 'Allow' })).toBeTruthy()
})
