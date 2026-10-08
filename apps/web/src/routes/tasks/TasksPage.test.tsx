import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Room, TaskSummary } from '@score/contract'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamClient } from '../../data/stream.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { TasksPage } from './TasksPage.tsx'
import { taskColumns, tasksQuery, type TaskFilters } from './task-queries.ts'

const at = '2026-10-08T12:00:00.000Z'
const agents: AgentSummary[] = [
  { id: 'lead', color: '#6B4EFF', shape: 'circle-dot' },
  { id: 'builder', color: '#19C39A', shape: 'triangle' },
  { id: 'reviewer', color: '#FFB61E', shape: 'diamond' },
  { id: 'designer', color: '#FF6B8A', shape: 'square' },
].map(({ id, color, shape }) => ({
  id,
  name: id,
  role: 'Example agent',
  style: { color, shape: shape as AgentSummary['style']['shape'] },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
}))
const rooms: Room[] = [
  {
    id: 'room-feed',
    name: '#activity-feed',
    kind: 'room',
    leadAgentId: 'lead',
    members: agents.map((agent) => agent.id),
    unread: 0,
    activeAgents: [],
    channels: [],
  },
]
function task(id: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    key: `T-${id}`,
    title: `Task ${id}`,
    column: 'planned',
    hermesStatus: 'ready',
    assignee: 'builder',
    reviewer: 'reviewer',
    roomId: 'room-feed',
    badge: null,
    progress: null,
    elapsedSec: null,
    note: null,
    updatedAt: at,
    ...overrides,
  }
}
function snapshot(tasks: TaskSummary[] = [], asOfSeq = 10) {
  return {
    asOfSeq,
    columns: Object.fromEntries(
      taskColumns.map(({ id }) => [id, tasks.filter((task) => task.column === id)]),
    ),
  }
}
const fetchMock = vi.fn<typeof fetch>()
let boardTasks: TaskSummary[]
class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = []
  constructor() {
    super()
    MockEventSource.instances.push(this)
  }
  close() {}
  upsert(task: TaskSummary, seq: number) {
    this.dispatchEvent(
      new MessageEvent('task.upserted', {
        data: JSON.stringify({ seq, ts: at, type: 'task.upserted', data: task }),
        lastEventId: String(seq),
      }),
    )
  }
  reset() {
    this.dispatchEvent(
      new MessageEvent('stream.reset', {
        data: JSON.stringify({ type: 'stream.reset', data: { reason: 'pruned' } }),
      }),
    )
  }
}
let source: MockEventSource
const disposers: (() => void)[] = []
function setup(path = '/tasks') {
  const client = createStreamClient({ EventSourceImpl: MockEventSource })
  source = MockEventSource.instances.at(-1)!
  const queryClient = createQueryClient()
  const queries = createStreamQueryRegistry(queryClient, client)
  const router = createMemoryRouter(
    [
      {
        path: '/tasks',
        Component: TasksPage,
        children: [
          { index: true, element: <></> },
          { path: ':taskId', element: <></> },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  disposers.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
    router.dispose()
  })
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <StreamContext value={{ client, queries }}>
          <RouterProvider router={router} />
        </StreamContext>
      </QueryClientProvider>
    </StrictMode>,
  )
  return { router, queries }
}
beforeEach(() => {
  boardTasks = []
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost')
    const data =
      url.pathname === '/api/agents'
        ? { asOfSeq: 10, items: agents }
        : url.pathname === '/api/rooms'
          ? { asOfSeq: 10, rooms, directs: [] }
          : snapshot(
              boardTasks.filter(
                (task) =>
                  (!url.searchParams.get('agent') ||
                    task.assignee === url.searchParams.get('agent')) &&
                  (!url.searchParams.get('room') || task.roomId === url.searchParams.get('room')) &&
                  (url.searchParams.get('needsYou') !== 'true' || task.column === 'needs_you'),
              ),
            )
    return new Response(JSON.stringify(data))
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

test('loading keeps five labeled columns available', () => {
  fetchMock.mockImplementation(() => new Promise(() => {}))
  setup()
  expect(screen.getByRole('status').textContent).toBe('Loading tasks…')
  for (const { label } of taskColumns)
    expect(screen.getByRole('region', { name: label })).toBeDefined()
})

test('empty board explains that there are no tasks', async () => {
  setup()
  await screen.findByText('No tasks yet.')
  expect(screen.getAllByText('No tasks')).toHaveLength(5)
})

test('failed task request can be retried', async () => {
  const fetchSnapshot = fetchMock.getMockImplementation()!
  let failed = true
  fetchMock.mockImplementation(async (input, init) =>
    failed && String(input).startsWith('/api/tasks')
      ? new Response(JSON.stringify({ error: { code: 'unavailable', message: 'Unavailable' } }), {
          status: 503,
        })
      : fetchSnapshot(input, init),
  )
  setup()
  await screen.findByText('Tasks could not load. Please try again.')
  boardTasks = [task('1')]
  failed = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry tasks' }))
  await screen.findByRole('link', { name: 'T-1: Task 1' })
  expect(screen.queryByText('Tasks could not load. Please try again.')).toBeNull()
})

test('rejects malformed task responses instead of rendering unvalidated data', async () => {
  const fetchSnapshot = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) =>
    String(input).startsWith('/api/tasks')
      ? new Response(JSON.stringify(snapshot([{ ...task('1'), progress: 2 }])))
      : fetchSnapshot(input, init),
  )
  setup()
  await screen.findByText('Tasks could not load. Please try again.')
  expect(screen.queryByRole('link', { name: 'T-1: Task 1' })).toBeNull()
})

test('populated board renders card variants, notes, time, agent shapes and room names', async () => {
  boardTasks = [
    task('1', { note: 'tomorrow' }),
    task('2', { column: 'working', progress: 0.6, elapsedSec: 360 }),
    task('3', {
      column: 'in_review',
      badge: { kind: 'changes_requested', label: 'Changes requested' },
    }),
    task('4', {
      column: 'needs_you',
      elapsedSec: 60,
      note: 'Wants to install a package',
      badge: { kind: 'needs_you', label: 'Needs your decision' },
    }),
    task('5', { column: 'done', elapsedSec: 3670 }),
    task('6', {
      column: 'working',
      assignee: 'designer',
      note: 'queued',
      badge: { kind: 'starts_after', label: 'Starts after review' },
    }),
  ]
  setup()
  await screen.findByRole('link', { name: 'T-1: Task 1' })
  await screen.findByRole('button', { name: 'builder' })
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('60')
  for (const text of [
    'tomorrow',
    '6 min',
    'Changes requested',
    'Wants to install a package',
    '1 min',
    '1 hr 1 min',
    'Starts after review',
    'queued',
  ])
    expect(screen.getByText(text)).toBeDefined()
  const review = screen.getByRole('link', { name: 'T-3: Task 3' })
  expect(review.querySelectorAll('.agent-glyph')).toHaveLength(2)
  expect(within(review).getByText('reviewer')).toBeDefined()
  expect(within(review).getByText('#activity-feed')).toBeDefined()
  expect(screen.getByRole('link', { name: 'T-5: Task 5' }).className).toContain('task-card--done')
})

test.each([
  ['blocked', 'Blocked'],
  ['triage', 'Triage'],
  ['starts_after', 'Starts later'],
] as const)('renders the %s badge', async (kind, label) => {
  boardTasks = [task('1', { badge: { kind, label } })]
  setup()
  await screen.findByText(label)
  expect(screen.getByText(label).className).toContain(`task-badge--${kind}`)
})

test('filters map to query params, combine, toggle off and preserve the URL', async () => {
  boardTasks = [task('1'), task('2', { assignee: 'lead', column: 'needs_you' })]
  const { router } = setup()
  await screen.findByRole('button', { name: 'lead' })
  fireEvent.click(screen.getByRole('button', { name: 'lead' }))
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith('/api/tasks?agent=lead', expect.anything()),
  )
  await waitFor(() => expect(screen.queryByRole('link', { name: 'T-1: Task 1' })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Needs you' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), {
    target: { value: 'room-feed' },
  })
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks?agent=lead&room=room-feed&needsYou=true',
      expect.anything(),
    ),
  )
  expect(new URLSearchParams(router.state.location.search).get('room')).toBe('room-feed')
  expect(screen.getByRole('button', { name: 'lead' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'lead' }))
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks?room=room-feed&needsYou=true',
      expect.anything(),
    ),
  )
})

test('a deep linked filter with no matches has an explanatory empty state', async () => {
  setup('/tasks?agent=builder&needsYou=true')
  await screen.findByText('No tasks match these filters.')
  expect(screen.getByRole('button', { name: 'Needs you' }).getAttribute('aria-pressed')).toBe(
    'true',
  )
})

test('arrow keys navigate rows, skip empty columns and clamp at boundaries', async () => {
  boardTasks = [
    task('1'),
    task('2'),
    task('3', { column: 'in_review' }),
    task('4', { column: 'done' }),
  ]
  setup()
  const first = await screen.findByRole('link', { name: 'T-1: Task 1' })
  const second = screen.getByRole('link', { name: 'T-2: Task 2' })
  first.focus()
  fireEvent.keyDown(first, { key: 'ArrowUp' })
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(first, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(second)
  fireEvent.keyDown(second, { key: 'ArrowRight' })
  const review = screen.getByRole('link', { name: 'T-3: Task 3' })
  expect(document.activeElement).toBe(review)
  fireEvent.keyDown(review, { key: 'ArrowLeft' })
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(first, { key: 'End' })
  expect(document.activeElement).toBe(second)
  fireEvent.keyDown(second, { key: 'Home' })
  expect(document.activeElement).toBe(first)
})

test('card opens a routed placeholder; Escape closes it and restores card focus', async () => {
  boardTasks = [task('1')]
  const { router } = setup('/tasks?room=room-feed')
  const card = await screen.findByRole('link', { name: 'T-1: Task 1' })
  fireEvent.click(card)
  await screen.findByRole('complementary', { name: 'Task details' })
  expect(router.state.location.pathname).toBe('/tasks/1')
  expect(router.state.location.search).toBe('?room=room-feed')
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Close details' }))
  expect(card.getAttribute('aria-current')).toBe('true')
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'))
  expect(document.activeElement).toBe(card)
})

test('deep links open a placeholder even when a task is absent from the filtered board', async () => {
  setup('/tasks/missing')
  expect(screen.getByRole('complementary', { name: 'Task details' })).toBeDefined()
  expect(screen.getByText('missing')).toBeDefined()
  await screen.findByText('No tasks yet.')
})

test('live upserts add, update and move cards exactly once and ignore older events', async () => {
  boardTasks = [task('1')]
  setup()
  await screen.findByRole('link', { name: 'T-1: Task 1' })
  act(() => source.upsert(task('1', { column: 'working', progress: 0.5 }), 11))
  expect(within(screen.getByRole('region', { name: 'Working' })).getByRole('link')).toBeDefined()
  expect(within(screen.getByRole('region', { name: 'Planned' })).queryByRole('link')).toBeNull()
  act(() => source.upsert(task('1'), 10))
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
  act(() => source.upsert(task('2', { column: 'needs_you' }), 12))
  act(() => source.upsert(task('2', { column: 'needs_you' }), 12))
  expect(screen.getAllByRole('link', { name: 'T-2: Task 2' })).toHaveLength(1)
  expect(screen.getByText('Task 2 updated in Needs you.').getAttribute('aria-live')).toBe('polite')
  act(() => source.upsert(task('2', { hermesStatus: 'archived' }), 13))
  expect(screen.queryByRole('link', { name: 'T-2: Task 2' })).toBeNull()
})

test('live updates remove tasks that stop matching the current filters and admit new matches', async () => {
  boardTasks = [task('1', { column: 'needs_you' })]
  setup('/tasks?agent=builder&room=room-feed&needsYou=true')
  await screen.findByRole('link', { name: 'T-1: Task 1' })
  act(() => source.upsert(task('1', { column: 'done' }), 11))
  expect(screen.queryByRole('link', { name: 'T-1: Task 1' })).toBeNull()
  act(() => source.upsert(task('2', { column: 'needs_you', assignee: 'lead' }), 12))
  act(() => source.upsert(task('3', { column: 'needs_you', roomId: 'other-room' }), 13))
  expect(screen.queryByRole('link', { name: 'T-2: Task 2' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'T-3: Task 3' })).toBeNull()
  act(() => source.upsert(task('4', { column: 'needs_you' }), 14))
  expect(screen.getByRole('link', { name: 'T-4: Task 4' })).toBeDefined()
})

test('a stream reset refetch buffers task changes after the snapshot watermark', async () => {
  boardTasks = [task('1')]
  const { queries } = setup()
  await screen.findByRole('link', { name: 'T-1: Task 1' })
  const request = Promise.withResolvers<Response>()
  fetchMock.mockImplementationOnce(() => request.promise)
  act(() => source.reset())
  act(() => source.upsert(task('1', { column: 'working', progress: 0.8 }), 12))
  await act(async () => {
    request.resolve(new Response(JSON.stringify(snapshot([task('1')], 11))))
  })
  await waitFor(() =>
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('80'),
  )
  const filters: TaskFilters = { agent: '', room: '', needsYou: false }
  expect(queries.register(tasksQuery(filters)).getSnapshot().asOfSeq).toBe(12)
})
