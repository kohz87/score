import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Approval, Room, TaskDetail } from '@score/contract'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamClient } from '../../data/stream.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { TasksPage } from './TasksPage.tsx'
import { approveLabel } from './TaskDrawer.tsx'

const at = '2026-10-08T12:00:00.000Z'
const agents: AgentSummary[] = [
  { id: 'lead', color: '#6B4EFF', shape: 'circle-dot' },
  { id: 'builder', color: '#19C39A', shape: 'triangle' },
  { id: 'reviewer', color: '#FFB61E', shape: 'diamond' },
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
    members: ['lead', 'builder'],
    unread: 0,
    activeAgents: [],
    channels: [],
  },
]
const approval: Approval = {
  id: 'approval-1',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'May I install the pagination dependency?',
  command: 'pnpm add @tanstack/react-virtual@3.13.12',
  cwd: null,
  description: 'Needs your approval.',
  choices: ['once', 'deny'],
  createdAt: at,
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: null,
  refs: [{ kind: 'task', taskId: 't1' }],
}
function detail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: 't1',
    key: 'T-1',
    title: 'Event stream for the feed',
    column: 'working',
    hermesStatus: 'running',
    assignee: 'builder',
    reviewer: 'reviewer',
    roomId: 'room-feed',
    badge: null,
    progress: null,
    elapsedSec: null,
    note: null,
    updatedAt: at,
    body: '',
    createdBy: 'you',
    steps: [
      { id: 's1', text: 'Subscribe to events', done: true },
      { id: 's2', text: 'Reconnect from the cursor', done: false },
    ],
    activity: [
      { at: '2026-10-08T12:01:00.000Z', agentId: 'builder', text: 'started this task' },
      { at: '2026-10-08T12:05:00.000Z', agentId: 'reviewer', text: 'left a note' },
    ],
    pendingApproval: null,
    dependsOn: [],
    blocks: [],
    runIds: [],
    briefId: 'brief-9',
    ...overrides,
  }
}

class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = []
  constructor() {
    super()
    MockEventSource.instances.push(this)
  }
  close() {}
  emit(type: string, data: unknown, seq: number) {
    this.dispatchEvent(
      new MessageEvent(type, {
        data: JSON.stringify({ seq, ts: at, type, data }),
        lastEventId: String(seq),
      }),
    )
  }
}
type Call = { path: string; method: string; body: unknown; headers: Headers }
let current: TaskDetail
let calls: Call[]
let respond: (call: Call) => Response | undefined
let source: MockEventSource
const disposers: (() => void)[] = []
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

function setup(path = '/tasks/t1') {
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
      { path: '/chat/:roomId', element: <p>chat room</p> },
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
  return router
}

beforeEach(() => {
  current = detail()
  calls = []
  respond = () => undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const call: Call = {
        path: url.pathname,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: new Headers(init?.headers),
      }
      calls.push(call)
      const custom = respond(call)
      if (custom) return custom
      if (url.pathname === '/api/agents') return json({ asOfSeq: 10, items: agents })
      if (url.pathname === '/api/rooms') return json({ asOfSeq: 10, rooms, directs: [] })
      if (url.pathname === '/api/tasks')
        return json({
          asOfSeq: 10,
          columns: { planned: [], working: [current], in_review: [], needs_you: [], done: [] },
        })
      if (url.pathname === '/api/tasks/t1' && call.method === 'GET') return json(current)
      if (url.pathname === '/api/tasks/t1' && call.method === 'PATCH') {
        current = { ...current, steps: (call.body as { steps: TaskDetail['steps'] }).steps }
        return json(current)
      }
      if (url.pathname === '/api/approvals/approval-1/decision')
        return json({ ...approval, phase: 'decided', status: 'approved' }, 202)
      if (url.pathname === '/api/tasks/t1/actions')
        return json({
          taskId: 't1',
          action: (call.body as { action: string }).action,
          hermesStatus: 'ready',
        })
      return json({ error: { code: 'not_found', message: 'Not found' } }, 404)
    }),
  )
})
afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
  MockEventSource.instances = []
})

const drawer = () => screen.findByRole('complementary', { name: 'Task details' })

test('shows a loading state, then the populated drawer', async () => {
  const pending = new Promise<Response>(() => {})
  respond = (call) => (call.path === '/api/tasks/t1' ? (pending as unknown as Response) : undefined)
  setup()
  expect((await drawer()).textContent).toContain('Loading task…')
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  respond = () => undefined
  setup()
  const panel = await drawer()
  await within(panel).findByRole('heading', { name: 'Event stream for the feed' })
  expect(within(panel).getByText('Working')).toBeDefined()
  expect(within(panel).getByText('T-1')).toBeDefined()
  expect(within(panel).getByText('Assigned to').nextSibling?.textContent).toBe('builder')
  expect(within(panel).getByText('Reviewer').nextSibling?.textContent).toBe('reviewer')
  expect(within(panel).getByText('Created by').nextSibling?.textContent).toBe('You')
  expect(within(panel).getByRole('link', { name: '#activity-feed' }).getAttribute('href')).toBe(
    '/chat/room-feed',
  )
  const items = within(panel).getAllByRole('listitem')
  const activity = items.filter((item) => item.querySelector('time'))
  expect(activity.map((item) => item.textContent)).toEqual([
    expect.stringContaining('left a note'),
    expect.stringContaining('started this task'),
  ])
  expect(within(panel).getByRole('link', { name: 'See it in Flow' }).getAttribute('href')).toBe(
    '/now/flow/brief-9?node=task%3At1',
  )
  expect(within(panel).getByRole('checkbox', { name: 'Subscribe to events' })).toHaveProperty(
    'checked',
    true,
  )
})

test('a task that belongs to no run offers no Flow link', async () => {
  current = detail({ briefId: null })
  setup()
  const panel = await drawer()
  await within(panel).findByRole('heading', { name: 'Event stream for the feed' })
  expect(within(panel).queryByRole('link', { name: 'See it in Flow' })).toBeNull()
})

test('a failed detail request can be retried', async () => {
  let fail = true
  respond = (call) =>
    fail && call.path === '/api/tasks/t1'
      ? json({ error: { code: 'unavailable', message: 'Unavailable' } }, 503)
      : undefined
  setup()
  await screen.findByText('Task details could not load.')
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry task' }))
  await screen.findByRole('heading', { name: 'Event stream for the feed' })
})

test('toggling a step saves it with PATCH', async () => {
  setup()
  const box = await screen.findByRole('checkbox', { name: 'Reconnect from the cursor' })
  fireEvent.click(box)
  await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true))
  const patch = calls.find((call) => call.method === 'PATCH')!
  expect(patch.body).toEqual({
    steps: [
      { id: 's1', text: 'Subscribe to events', done: true },
      { id: 's2', text: 'Reconnect from the cursor', done: true },
    ],
  })
  expect(patch.headers.get('X-Score-Client')).toBe('web')
  await waitFor(() =>
    expect(
      (screen.getByRole('checkbox', { name: 'Reconnect from the cursor' }) as HTMLInputElement)
        .checked,
    ).toBe(true),
  )
})

test('a failed step save reverts the checkbox and says so', async () => {
  respond = (call) =>
    call.method === 'PATCH'
      ? json({ error: { code: 'hermes_unavailable', message: 'Hermes is offline' } }, 502)
      : undefined
  setup()
  const box = (await screen.findByRole('checkbox', {
    name: 'Reconnect from the cursor',
  })) as HTMLInputElement
  fireEvent.click(box)
  await screen.findByText(/Could not save that step\. Hermes is offline/)
  expect(box.checked).toBe(false)
  expect(box.disabled).toBe(false)
})

test('steps become read-only when the server answers 501', async () => {
  respond = (call) =>
    call.method === 'PATCH'
      ? json({ error: { code: 'not_implemented', message: 'Not built yet' } }, 501)
      : undefined
  setup()
  const box = (await screen.findByRole('checkbox', {
    name: 'Reconnect from the cursor',
  })) as HTMLInputElement
  fireEvent.click(box)
  await screen.findByText('Steps are read-only for now.')
  expect(box.checked).toBe(false)
  expect(box.disabled).toBe(true)
})

test('an actionable approval becomes the primary action and approves once', async () => {
  current = detail({ column: 'needs_you', pendingApproval: approval })
  setup()
  const button = await screen.findByRole('button', {
    name: 'Approve: install the pagination dependency',
  })
  expect(screen.queryByRole('button', { name: 'Add comment' })).toBeNull()
  expect(screen.getByText('pnpm add @tanstack/react-virtual@3.13.12')).toBeDefined()
  fireEvent.click(button)
  await screen.findByText('Approval sent. Waiting for the agent to continue.')
  const decision = calls.find((call) => call.path === '/api/approvals/approval-1/decision')!
  expect(decision.method).toBe('POST')
  expect(decision.body).toEqual({ choice: 'once' })
  expect(decision.headers.get('Idempotency-Key')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull()
})

test('a rejected approval shows the error and keeps the button', async () => {
  current = detail({ column: 'needs_you', pendingApproval: approval })
  respond = (call) =>
    call.path.endsWith('/decision')
      ? json({ error: { code: 'conflict', message: 'Already decided' } }, 409)
      : undefined
  setup()
  fireEvent.click(await screen.findByRole('button', { name: /^Approve/ }))
  await screen.findByText('Already decided')
  expect(screen.getByRole('button', { name: /^Approve/ })).toBeDefined()
})

test('a non-actionable approval has no approve button but keeps task actions', async () => {
  current = detail({
    column: 'needs_you',
    hermesStatus: 'blocked',
    pendingApproval: { ...approval, origin: 'kanban', actionable: false, choices: [] },
  })
  setup()
  await screen.findByText('This approval can only be answered in Hermes.')
  expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Unblock' }))
  await screen.findByText('Task unblocked.')
  expect(calls.find((call) => call.path === '/api/tasks/t1/actions')!.body).toEqual({
    action: 'unblock',
  })
})

test('comments post a task action and clear the field', async () => {
  setup()
  const field = (await screen.findByLabelText('Comment')) as HTMLTextAreaElement
  expect((screen.getByRole('button', { name: 'Add comment' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  fireEvent.change(field, { target: { value: 'Looks good' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
  await screen.findByText('Comment added.')
  expect(calls.find((call) => call.path === '/api/tasks/t1/actions')!.body).toEqual({
    action: 'comment',
    text: 'Looks good',
  })
  expect(field.value).toBe('')
  expect(screen.queryByRole('button', { name: 'Unblock' })).toBeNull()
})

test('stream events refresh the open drawer', async () => {
  setup()
  await screen.findByText('left a note')
  current = detail({
    activity: [
      ...current.activity,
      { at: '2026-10-08T12:09:00.000Z', agentId: 'lead', text: 'approved the plan' },
    ],
  })
  act(() =>
    source.emit(
      'task.activity',
      { taskId: 't1', item: { at: '2026-10-08T12:09:00.000Z', agentId: 'lead', text: 'x' } },
      11,
    ),
  )
  await screen.findByText('approved the plan')
  current = detail({ column: 'needs_you', pendingApproval: approval })
  act(() => source.emit('approval.requested', approval, 12))
  await screen.findByRole('button', { name: /^Approve/ })
  current = detail()
  act(() => source.emit('approval.updated', { ...approval, status: 'approved' }, 13))
  await waitFor(() => expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull())
})

test('approve labels shorten the approval title', () => {
  expect(approveLabel('May I push the branch?')).toBe('Approve: push the branch')
  expect(approveLabel('Delete the cache')).toBe('Approve: Delete the cache')
  expect(approveLabel(`May I ${'x'.repeat(80)}?`).length).toBe(60)
})
