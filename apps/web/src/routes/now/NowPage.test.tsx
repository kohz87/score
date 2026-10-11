import { QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Approval, NowSnapshot } from '@score/contract'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { NowPage } from './NowPage.tsx'

// Several workers share the machine; the default 1 s is tight for a page that fetches four things.
configure({ asyncUtilTimeout: 5000 })

class Source extends EventTarget {
  close() {}
}

const agent = (id: string, color: string, shape: AgentSummary['style']['shape']): AgentSummary => ({
  id,
  name: id,
  role: `${id} role`,
  style: { color, shape },
  status: id === 'builder' ? 'working' : 'idle',
  activity: null,
  model: null,
  served: true,
})
const agents = [
  agent('lead', '#6B4EFF', 'circle-dot'),
  agent('builder', '#19C39A', 'triangle'),
  agent('reviewer', '#FFB61E', 'diamond'),
]
const now = '2026-10-08T21:31:00.000Z'
const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString()
const approval: Approval = {
  id: 'ap1',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'Can I install a package?',
  command: 'npm install ws@8',
  cwd: '/srv/app',
  description: 'x',
  choices: ['once', 'session', 'always', 'deny'],
  createdAt: at(-1),
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: 'Only this command is waiting.',
  refs: [],
}
function snapshot(overrides: Partial<NowSnapshot> = {}): NowSnapshot {
  return {
    asOfSeq: 5,
    now,
    paused: false,
    headline: { working: 1, needsYou: 1, text: 'One agent is working. One thing needs you.' },
    lanes: [
      {
        agent: agents[0]!,
        blocks: [
          {
            id: 'p',
            label: 'Plan and assign',
            state: 'done',
            start: at(-60),
            end: at(-45),
            taskId: 't-plan',
            runId: null,
            kind: 'task',
          },
        ],
      },
      {
        agent: agents[1]!,
        blocks: [
          {
            id: 'w',
            label: 'Stream',
            state: 'working',
            start: at(-20),
            end: null,
            taskId: null,
            runId: 'r1',
            kind: 'task',
          },
          {
            id: 'x',
            label: 'Waiting on you',
            state: 'waiting',
            start: at(-1),
            end: null,
            taskId: null,
            runId: 'r1',
            kind: 'task',
          },
        ],
      },
      {
        agent: agents[2]!,
        blocks: [
          {
            id: 'r',
            label: 'Sign off',
            state: 'planned',
            start: at(20),
            end: null,
            taskId: null,
            runId: null,
            kind: 'task',
          },
        ],
      },
    ],
    handoffs: [
      {
        id: 'h',
        from: { agentId: 'lead', blockId: 'p' },
        to: { agentId: 'builder', blockId: 'w' },
        kind: 'handoff',
        at: at(-45),
      },
    ],
    focusApproval: approval,
    thread: {
      roomId: 'room1',
      messages: [
        {
          id: 'm1',
          roomId: 'room1',
          author: { kind: 'agent', agentId: 'lead' },
          to: [],
          parts: [{ kind: 'text', text: 'Make it composite.' }],
          createdAt: at(-5),
          streaming: false,
          refs: [],
        },
      ],
    },
    madeToday: [
      {
        title: 'Read layer',
        ref: { kind: 'task', taskId: 't1' },
        files: [{ path: 'api/events.py', added: 182, removed: 12 }],
        checks: [{ label: 'Tests pass', agentId: 'builder', verdict: 'passed' }],
      },
    ],
    ...overrides,
  }
}

let current: NowSnapshot
let paused: boolean
let queuedDecision = false
let calls: { url: string; method: string; body: string | undefined; key: string | null }[]
const cleanups: (() => void)[] = []

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }))
}
beforeEach(() => {
  queuedDecision = false
  current = snapshot()
  paused = false
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const key = new Headers(init?.headers).get('Idempotency-Key')
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined, key })
      if (url === '/api/now')
        return respond(
          paused
            ? {
                ...current,
                paused: true,
                headline: { ...current.headline, text: 'Everyone is paused. One thing needs you.' },
              }
            : current,
        )
      if (url === '/api/team/pause') {
        paused = true
        return respond({ paused: true, affectedRuns: 1 })
      }
      if (url === '/api/team/resume') {
        paused = false
        return respond({ paused: false, affectedRuns: 1 })
      }
      if (url === '/api/approvals/ap1/decision' && queuedDecision)
        return respond({ ...approval, delivery: 'intent' })
      if (url === '/api/approvals/ap1/decision')
        return respond({
          ...approval,
          phase: 'decided',
          status: 'approved',
          actionable: false,
          decision: { by: 'you', choice: 'once', at: now },
          delivery: 'applied',
        })
      if (url === '/api/rooms')
        return respond({
          asOfSeq: 1,
          rooms: [
            {
              id: 'room1',
              name: '#feed',
              kind: 'room',
              leadAgentId: 'lead',
              members: ['lead'],
              unread: 0,
              activeAgents: [],
              channels: [],
            },
          ],
          directs: [],
        })
      if (url === '/api/commands') return respond({ items: [] })
      if (url.startsWith('/api/agents/') && url.endsWith('/routines'))
        return respond({
          items: [
            {
              id: 'r1',
              title: 'Nightly check',
              schedule: '0 2 * * *',
              description: '',
              lastRunAt: null,
              enabled: true,
            },
          ],
        })
      return respond({ error: { code: 'not_found', message: 'no' } }, 404)
    }),
  )
})
afterEach(() => {
  cleanup()
  cleanups.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})

function Where() {
  return <output aria-label="location">{useLocation().pathname}</output>
}
function renderNow(path = '/now') {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  cleanups.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            <NowPage />
            <Where />
          </>
        ),
      },
    ],
    { initialEntries: [path] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}

test('shows the headline, a lane per agent, blocks by state and the legend', async () => {
  renderNow()
  expect(
    await screen.findByRole('heading', {
      level: 1,
      name: 'One agent is working. One thing needs you.',
    }),
  ).toBeTruthy()
  const timeline = screen.getByRole('region', { name: /^Score:/ })
  expect(within(timeline).getByRole('group', { name: 'lead, lead role' })).toBeTruthy()
  expect(within(timeline).getByRole('button', { name: /lead: Plan and assign, done/ })).toBeTruthy()
  expect(
    within(timeline).getByRole('button', { name: /builder: Stream, working now/ }),
  ).toBeTruthy()
  expect(
    within(timeline).getByRole('button', { name: /builder: Waiting on you, waiting on you/ }),
  ).toBeTruthy()
  expect(within(timeline).getByRole('button', { name: /reviewer: Sign off, planned/ })).toBeTruthy()
  expect(within(timeline).getByText('Now, 21:31')).toBeTruthy()
  expect(within(timeline).getByText('Planned by lead')).toBeTruthy()
  expect(
    within(timeline).getByText('Hand-off: lead (Plan and assign) to builder (Stream)'),
  ).toBeTruthy()
})

test('a block with a task opens the task from the keyboard; one without does nothing', async () => {
  renderNow()
  const withTask = await screen.findByRole('button', { name: /lead: Plan and assign/ })
  withTask.focus()
  expect(document.activeElement).toBe(withTask)
  fireEvent.click(withTask)
  await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/tasks/t-plan'))
})

test('the cards render the thread, the asking card, made today and the composer', async () => {
  renderNow()
  const thread = await screen.findByRole('region', { name: 'Room' })
  expect(within(thread).getByText('Make it composite.')).toBeTruthy()
  expect(within(thread).getByRole('link', { name: 'Open in Chat' }).getAttribute('href')).toBe(
    '/chat/room1',
  )
  const asking = screen.getByRole('region', { name: 'Needs you' })
  expect(within(asking).getByText('builder is asking')).toBeTruthy()
  expect(within(asking).getByText('npm install ws@8')).toBeTruthy()
  const made = screen.getByRole('region', { name: 'Made today' })
  expect(within(made).getByText('api/events.py')).toBeTruthy()
  expect(within(made).getByText('+182')).toBeTruthy()
  expect(await screen.findByRole('combobox', { name: 'Message #feed' })).toBeTruthy()
})

test('Approve posts the decision once with an idempotency key and shows the outcome', async () => {
  renderNow()
  const asking = await screen.findByRole('region', { name: 'Needs you' })
  fireEvent.click(within(asking).getByRole('button', { name: 'Approve' }))
  expect((await within(asking).findAllByText(/You approved/)).length).toBeGreaterThan(0)
  const decisions = calls.filter((call) => call.url === '/api/approvals/ap1/decision')
  expect(decisions).toHaveLength(1)
  expect(decisions[0]).toMatchObject({ method: 'POST', body: JSON.stringify({ choice: 'once' }) })
  expect(decisions[0]!.key).toBeTruthy()
})

test('a queued approval is not announced as approved', async () => {
  queuedDecision = true
  renderNow()
  const asking = await screen.findByRole('region', { name: 'Needs you' })
  fireEvent.click(within(asking).getByRole('button', { name: 'Approve' }))
  expect(await within(asking).findByText(/Decision queued/)).toBeTruthy()
  expect(within(asking).queryByText(/You approved/)).toBeNull()
})

test('with nothing to decide the card says so', async () => {
  current = snapshot({ focusApproval: null })
  renderNow()
  expect(await screen.findByRole('heading', { name: 'Nothing needs you' })).toBeTruthy()
})

test('Pause everyone and Resume everyone round trip through the headline', async () => {
  renderNow()
  await screen.findByRole('heading', { level: 1, name: /working/ })
  fireEvent.click(screen.getByRole('button', { name: 'Pause everyone' }))
  expect(await screen.findByRole('button', { name: 'Resume everyone' })).toBeTruthy()
  expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Everyone is paused\./)
  expect(
    calls.some((call) => call.url === '/api/team/pause' && call.method === 'POST' && call.key),
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Resume everyone' }))
  expect(await screen.findByRole('button', { name: 'Pause everyone' })).toBeTruthy()
  expect(calls.some((call) => call.url === '/api/team/resume')).toBe(true)
})

test('the view switch links to Score, Flow and Routines; Routines lists every agent read-only', async () => {
  renderNow('/now/routines')
  const views = await screen.findByRole('navigation', { name: 'Views' })
  expect(within(views).getByRole('link', { name: 'Score' }).getAttribute('href')).toBe('/now')
  expect(within(views).getByRole('link', { name: 'Flow' }).getAttribute('href')).toBe('/now/flow')
  expect(within(views).getByRole('link', { name: 'Routines' }).getAttribute('href')).toBe(
    '/now/routines',
  )
  await waitFor(() => expect(screen.getAllByText('Nightly check')).toHaveLength(3))
  expect(
    screen
      .getAllByRole('link', { name: 'Manage on the Team page' })
      .map((link) => link.getAttribute('href')),
  ).toEqual(['/team/lead', '/team/builder', '/team/reviewer'])
})

test('Flow renders the flow view inside the Now shell', async () => {
  renderNow('/now/flow')
  // The shell keeps the headline and the view switch; the flow view brings its own heading.
  expect(await screen.findByRole('heading', { level: 2, name: 'Flow' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Flow' }).getAttribute('aria-current')).toBe('page')
})

const crowdedLane = (agentId: string) => ({
  agent: agents.find((item) => item.id === agentId)!,
  blocks: [
    ...[0, 1, 2].map((index) => ({
      id: `g${index}`,
      label: `Crowded task ${index}`,
      state: 'done' as const,
      start: at(-40 + index),
      end: at(-30 + index),
      taskId: `t-g${index}`,
      runId: null,
      kind: 'task' as const,
    })),
    {
      id: 'chat:c1',
      label: 'Chat · 4 replies',
      state: 'done' as const,
      start: at(-50),
      end: at(-35),
      taskId: null,
      runId: null,
      kind: 'chat' as const,
      count: 4,
    },
  ],
})

test('crowded task blocks become one "N tasks" group with an accessible list; chat is a band', async () => {
  const base = snapshot()
  current = { ...base, lanes: [crowdedLane('lead'), ...base.lanes.slice(1)], handoffs: [] }
  renderNow()
  const timeline = await screen.findByRole('region', { name: /^Score:/ })
  expect(within(timeline).queryByRole('button', { name: /Crowded task 0/ })).toBeNull()
  expect(within(timeline).getByRole('img', { name: /lead: Chat · 4 replies/ })).toBeTruthy()
  expect(within(timeline).getByText('Chatting')).toBeTruthy()
  const group = within(timeline).getByRole('button', { name: /lead: 3 tasks, done/ })
  expect(group.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(group)
  expect(group.getAttribute('aria-expanded')).toBe('true')
  const list = within(timeline).getByRole('list', { name: 'lead: 3 tasks' })
  expect(within(list).getAllByRole('button')).toHaveLength(3)
  fireEvent.click(within(list).getByRole('button', { name: /Crowded task 1/ }))
  await waitFor(() => expect(screen.getByLabelText('location').textContent).toBe('/tasks/t-g1'))
})

test('Escape closes the group list and returns focus to the group', async () => {
  const base = snapshot()
  current = { ...base, lanes: [crowdedLane('lead'), ...base.lanes.slice(1)], handoffs: [] }
  renderNow()
  const timeline = await screen.findByRole('region', { name: /^Score:/ })
  const group = within(timeline).getByRole('button', { name: /lead: 3 tasks/ })
  fireEvent.click(group)
  const first = within(timeline).getAllByRole('button', { name: /Crowded task/ })[0]!
  first.focus()
  fireEvent.keyDown(first, { key: 'Escape' })
  expect(within(timeline).queryByRole('list', { name: 'lead: 3 tasks' })).toBeNull()
  expect(document.activeElement).toBe(group)
})
