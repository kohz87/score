import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Approval, MessagePart, StreamEvent } from '@score/contract'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { ApprovalCard, approvalOutcome } from './ApprovalCard.tsx'
import { PlanCard, planAxis } from './PlanCard.tsx'

class Source extends EventTarget {
  static current: Source
  constructor() {
    super()
    Source.current = this
  }
  close() {}
  emit(event: StreamEvent) {
    this.dispatchEvent(
      new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: String(event.seq) }),
    )
  }
}
const base: Approval = {
  id: 'a1',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'May I install ws?',
  command: 'pnpm add ws@8',
  cwd: null,
  description: 'Needs the websocket library',
  choices: ['once', 'session', 'always', 'deny'],
  createdAt: '2026-10-08T10:00:00.000Z',
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: null,
  refs: [],
}
let current: Approval[]
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
const cleanups: (() => void)[] = []

function renderCard(approvalId = 'a1') {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  cleanups.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <StreamContext value={{ client, queries }}>
          <ApprovalCard approvalId={approvalId} />
        </StreamContext>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}
function emitApproval(approval: Approval, seq: number) {
  act(() =>
    Source.current.emit({
      type: 'approval.updated',
      data: approval,
      seq,
      ts: '2026-10-08T10:00:00.000Z',
    } as StreamEvent),
  )
}
beforeEach(() => {
  current = [base]
  fetchMock = vi.fn(async (input) => {
    if (String(input).startsWith('/api/approvals?'))
      return new Response(JSON.stringify({ asOfSeq: 1, items: current, nextCursor: null }))
    return new Response(JSON.stringify({ ...base, delivery: 'intent' }), { status: 202 })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  cleanups.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

test('an actionable approval shows its details and posts the chosen decision with an idempotency key', async () => {
  renderCard()
  await screen.findByText('May I install ws?')
  expect(screen.getByText('pnpm add ws@8').tagName).toBe('CODE')
  expect(screen.getByText('Needs the websocket library')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await screen.findByText('Sending…')
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/decision'))!
  expect(String(call[0])).toBe('/api/approvals/a1/decision')
  expect(call[1]?.method).toBe('POST')
  expect(new Headers(call[1]?.headers).get('Idempotency-Key')).toBeTruthy()
  expect(JSON.parse(String(call[1]?.body))).toEqual({ choice: 'once' })
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  emitApproval(
    {
      ...base,
      phase: 'decided',
      status: 'approved',
      actionable: false,
      delivery: 'applied',
      decision: { choice: 'once', by: 'you', at: base.createdAt },
    },
    2,
  )
  await screen.findByText('You approved')
})

test('deny and the More menu send their own choices', async () => {
  renderCard()
  await screen.findByText('May I install ws?')
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/decision'))).toBe(true),
  )
  expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body))).toEqual({ choice: 'deny' })
})

test('More offers session and always', async () => {
  renderCard()
  await screen.findByText('May I install ws?')
  fireEvent.click(screen.getByRole('button', { name: 'More' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Approve for this session' }))
  await screen.findByText('Sending…')
  expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body))).toEqual({ choice: 'session' })
})

test('only the offered choices render', async () => {
  current = [{ ...base, choices: ['once'] }]
  renderCard()
  await screen.findByText('May I install ws?')
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
})

test('a rejected decision shows the error and keeps the buttons', async () => {
  fetchMock.mockImplementation(async (input) =>
    String(input).startsWith('/api/approvals?')
      ? new Response(JSON.stringify({ asOfSeq: 1, items: [base], nextCursor: null }))
      : new Response(JSON.stringify({ error: { code: 'conflict', message: 'Already answered' } }), {
          status: 409,
        }),
  )
  renderCard()
  await screen.findByText('May I install ws?')
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await screen.findByText('Already answered')
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined()
})

test.each<[string, Partial<Approval>, string]>([
  ['not_pending delivery', { delivery: 'not_pending', actionable: false }, 'Answered elsewhere'],
  ['unknown delivery', { delivery: 'unknown', actionable: false }, 'May have been answered'],
  ['delivering', { delivery: 'delivering', actionable: false }, 'Sending…'],
  ['intent', { delivery: 'intent', actionable: false }, 'Sending…'],
  [
    'applied deny',
    {
      delivery: 'applied',
      actionable: false,
      status: 'denied',
      decision: { choice: 'deny', by: 'you', at: base.createdAt },
    },
    'You denied',
  ],
  [
    'applied session',
    {
      delivery: 'applied',
      actionable: false,
      decision: { choice: 'session', by: 'you', at: base.createdAt },
    },
    'You approved for this session',
  ],
  [
    'decided elsewhere',
    {
      actionable: false,
      status: 'approved',
      decision: { choice: 'once', by: 'elsewhere', at: base.createdAt },
    },
    'Answered elsewhere (approved)',
  ],
  [
    'guardian',
    {
      actionable: false,
      status: 'denied',
      decision: { choice: 'deny', by: 'guardian', at: base.createdAt },
    },
    'Guardian denied this',
  ],
  ['expired', { actionable: false, status: 'expired' }, 'Expired'],
  ['withdrawn', { actionable: false, status: 'withdrawn' }, 'Withdrawn'],
])('delivery and outcome text: %s', async (_name, patch, text) => {
  current = [{ ...base, ...patch }]
  renderCard()
  await screen.findByText(text)
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
})

test('a failed delivery that can be retried offers the buttons again', async () => {
  current = [{ ...base, delivery: 'failed' }]
  renderCard()
  await screen.findByText('Delivery failed. You can try again.')
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined()
})

test('non-actionable approvals explain where to answer', async () => {
  current = [
    { ...base, id: 'g', origin: 'gateway', actionable: false },
    {
      ...base,
      id: 'k',
      origin: 'kanban',
      actionable: false,
      choices: [],
      refs: [{ kind: 'task', taskId: 'task-1' }],
    },
  ]
  renderCard('g')
  await screen.findByText('Answer in the gateway chat.')
  cleanup()
  renderCard('k')
  const link = await screen.findByRole('link', { name: 'Open the task' })
  expect(link.getAttribute('href')).toBe('/tasks/task-1')
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
})

test('an unknown approval says so', async () => {
  renderCard('missing')
  await screen.findByText('This approval is no longer available.')
})

test('outcome is null while an approval is open', () => {
  expect(approvalOutcome(base)).toBeNull()
})

const agent: AgentSummary = {
  id: 'builder',
  name: 'Builder',
  role: 'Builds',
  style: { color: '#19C39A', shape: 'triangle' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
}
const t = (minute: number) => new Date(Date.UTC(2026, 9, 8, 10, minute)).toISOString()
const plan: Extract<MessagePart, { kind: 'plan' }> = {
  kind: 'plan',
  briefId: 'brief 1',
  lanes: [
    {
      agentId: 'builder',
      blocks: ['done', 'working', 'planned', 'waiting'].map((state, index) => ({
        id: `b-${state}`,
        label: `Block ${state}`,
        state: state as 'done',
        start: t(index * 20),
        end: state === 'working' ? null : t(index * 20 + 10),
        taskId: null,
        runId: null,
      })),
    },
    { agentId: 'ghost', blocks: [] },
  ],
}

test('the plan card renders each block state on a shared axis and links to Score', () => {
  render(
    <MemoryRouter>
      <PlanCard part={plan} agents={[agent]} />
    </MemoryRouter>,
  )
  for (const state of ['done', 'working', 'planned', 'waiting']) {
    const block = screen.getByTitle(new RegExp(`Block ${state}`))
    expect(block.className).toContain(`chat-plan-block--${state}`)
  }
  expect(screen.getByText('Builder')).toBeDefined()
  expect(screen.getByText('ghost')).toBeDefined()
  expect(screen.getByRole('link', { name: 'Open in Score' }).getAttribute('href')).toBe(
    '/now?brief=brief%201',
  )
  const axis = planAxis(plan.lanes)!
  expect(axis.get('b-done')!.left).toBe(0)
  expect(axis.get('b-planned')!.left).toBeGreaterThan(axis.get('b-working')!.left)
  expect(planAxis([{ agentId: 'builder', blocks: [] }])).toBeNull()
})
