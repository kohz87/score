import type { Approval, Exchange } from '@score/contract'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { approvalsQuery } from '../../routes/chat/queries.ts'
import {
  disposeRoomTest,
  jsonResponse,
  makeExchange,
  makeJob,
  makeMessage,
  mockFetch,
  renderInRoom,
} from './room-test-utils.tsx'
import { RoomRequests } from './RoomRequests.tsx'
import { roomExchangesQuery } from './room-queries.ts'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const approval: Approval = {
  id: 'approval-1',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'builder',
  title: 'May I install a package?',
  command: 'npm install ws@8',
  cwd: '~/app',
  description: 'The websocket feed needs ws.',
  choices: ['once', 'session', 'always', 'deny'],
  createdAt: '2026-10-24T09:03:00.000Z',
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: null,
  refs: [],
}

const job = makeJob({ id: 'job-1', title: 'Activity feed' })
const other = makeJob({ id: 'job-2', title: 'Release notes', state: 'working' })

const resolvedApproval: Approval = {
  ...approval,
  phase: 'decided',
  status: 'approved',
  actionable: false,
  decision: { choice: 'once', by: 'you', at: '2026-10-24T09:05:00.000Z' },
  delivery: 'applied',
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function stubRoom(
  exchange: Exchange | null,
  decided = approval,
  decisionGate: Promise<void> = Promise.resolve(),
) {
  const fetchMock = mockFetch(async (url, init) => {
    if (url === '/api/approvals?status=all') {
      if (init.method === 'POST') throw new Error('not the approvals list')
      return jsonResponse({ asOfSeq: 1, items: [approval], nextCursor: null })
    }
    if (url === '/api/approvals/approval-1/decision') {
      await decisionGate
      return jsonResponse({
        ...approval,
        ...decided,
        phase: 'decided',
        status: 'approved',
        actionable: false,
        decision: { choice: 'once', by: 'you', at: '2026-10-24T09:05:00.000Z' },
        delivery: 'applied',
      })
    }
    if (url === '/api/exchanges/exchange-1/decision') {
      await decisionGate
      return jsonResponse({ asOfSeq: 0, items: [] })
    }
    if (url.startsWith('/api/jobs/')) {
      const items = exchange && url.includes(exchange.jobId) ? [exchange] : []
      return jsonResponse({ asOfSeq: 1, items })
    }
    return jsonResponse({ asOfSeq: 0, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

test('an approval leads the pins, the count expands the rest, and both are protected', async () => {
  stubRoom(makeExchange())
  renderInRoom(
    <RoomRequests
      jobs={[job, other]}
      agents={[]}
      selectedJob="all"
      messages={[
        makeMessage({
          id: 'approval:approval-1',
          jobId: job.id,
          parts: [{ kind: 'approval', approvalId: approval.id }],
        }),
      ]}
    />,
  )

  const approvalCard = await screen.findByRole('article', { name: /May I install a package/ })
  expect(approvalCard.getAttribute('data-protected')).toBe('flex')
  expect(approvalCard.textContent).toContain('npm install ws@8')
  expect(approvalCard.textContent).toContain('Activity feed')

  const pins = screen.getByLabelText('Needs you')
  expect(pins.getAttribute('data-expanded')).toBe('false')
  fireEvent.click(await screen.findByRole('button', { name: '1 more needs you' }))
  expect(pins.getAttribute('data-expanded')).toBe('true')
  expect(screen.getByRole('button', { name: 'Show fewer' })).toBeDefined()

  const exchangeCard = await screen.findByRole('article', {
    name: /The exchange used its turns/,
  })
  expect(exchangeCard.getAttribute('data-protected')).toBe('flex')
  expect(exchangeCard.textContent).toContain('8 of 8 turns')
})

test('Allow sends the approval decision once and the answered card goes', async () => {
  const decisionGate = deferred<void>()
  const fetchMock = stubRoom(null, approval, decisionGate.promise)
  const { queryClient } = renderInRoom(
    <RoomRequests
      jobs={[job]}
      agents={[]}
      selectedJob="all"
      messages={[
        makeMessage({
          id: 'approval:approval-1',
          jobId: job.id,
          parts: [{ kind: 'approval', approvalId: approval.id }],
        }),
      ]}
    />,
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Allow' }))
  await screen.findByText('Sending…')
  const posts = fetchMock.mock.calls.filter(
    ([url, init]) =>
      String(url) === '/api/approvals/approval-1/decision' && init?.method === 'POST',
  )
  expect(posts).toHaveLength(1)
  expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({ choice: 'once' })

  decisionGate.resolve()
  await screen.findByText('Approved by you')
  expect(screen.getByRole('article', { name: /May I install a package/ })).toBeDefined()

  act(() =>
    queryClient.setQueryData(approvalsQuery.key, {
      asOfSeq: 2,
      data: [resolvedApproval],
    }),
  )
  await waitFor(() =>
    expect(screen.queryByRole('article', { name: /May I install a package/ })).toBeNull(),
  )
})

test('send back asks for the note the exchange decision needs, then posts it', async () => {
  const exchange = makeExchange({
    pause: { reason: 'no_decision', options: ['send_back', 'close'] },
  })
  const decisionGate = deferred<void>()
  const fetchMock = stubRoom(exchange, approval, decisionGate.promise)
  const { queryClient } = renderInRoom(
    <RoomRequests jobs={[job]} agents={[]} selectedJob="all" messages={[]} />,
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Send back' }))
  const note = screen.getByLabelText('Note for the author')
  fireEvent.change(note, { target: { value: 'Add the migration steps.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send back' }))

  await screen.findByText('Sending…')
  const posts = fetchMock.mock.calls.filter(
    ([url, init]) =>
      String(url) === '/api/exchanges/exchange-1/decision' && init?.method === 'POST',
  )
  expect(posts).toHaveLength(1)
  expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({
    option: 'send_back',
    note: 'Add the migration steps.',
  })

  decisionGate.resolve()
  await screen.findByText('Sent back with your note.')
  expect(screen.getByRole('article', { name: /review ended without a verdict/ })).toBeDefined()

  act(() =>
    queryClient.setQueryData(roomExchangesQuery([job.id]).key, {
      asOfSeq: 2,
      data: [
        makeExchange({
          pause: null,
          state: 'waiting_on_agent',
          updatedAt: '2026-10-24T09:05:00.000Z',
        }),
      ],
    }),
  )
  await waitFor(() =>
    expect(screen.queryByRole('article', { name: /review ended without a verdict/ })).toBeNull(),
  )
})

test('More offers this session and always for the asking agent', async () => {
  const fetchMock = stubRoom(null)
  renderInRoom(
    <RoomRequests
      jobs={[job]}
      agents={[]}
      selectedJob="all"
      messages={[
        makeMessage({
          id: 'approval:approval-1',
          jobId: job.id,
          parts: [{ kind: 'approval', approvalId: approval.id }],
        }),
      ]}
    />,
  )

  const more = await screen.findByRole('button', { name: 'More' })
  expect(more.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(more)
  expect(more.getAttribute('aria-expanded')).toBe('true')
  expect(screen.queryByRole('menuitem')).toBeNull()
  expect(screen.getByRole('button', { name: 'Always allow for builder' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Approve for this session' }))
  const post = await waitFor(() => {
    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === '/api/approvals/approval-1/decision' && init?.method === 'POST',
    )
    expect(call).toBeDefined()
    return call!
  })
  expect(JSON.parse(String(post[1]!.body))).toEqual({ choice: 'session' })
})

test('a failed delivery explains the retry and keeps the approval open', async () => {
  vi.stubGlobal(
    'fetch',
    mockFetch((url) => {
      if (url === '/api/approvals?status=all')
        return jsonResponse({
          asOfSeq: 1,
          items: [{ ...approval, delivery: 'failed' }],
          nextCursor: null,
        })
      return jsonResponse({ asOfSeq: 0, items: [] })
    }),
  )
  renderInRoom(<RoomRequests jobs={[job]} agents={[]} selectedJob="all" messages={[]} />)
  await screen.findByText('Couldn’t deliver your answer. Try again.')
  const retry = screen.getByRole('button', { name: 'Retry' })
  expect((retry as HTMLButtonElement).disabled).toBe(false)
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
})

test('an approval answered outside Score says where to answer it', async () => {
  vi.stubGlobal(
    'fetch',
    mockFetch((url) => {
      if (url === '/api/approvals?status=all')
        return jsonResponse({
          asOfSeq: 1,
          items: [{ ...approval, origin: 'gateway', actionable: false }],
          nextCursor: null,
        })
      return jsonResponse({ asOfSeq: 0, items: [] })
    }),
  )
  renderInRoom(<RoomRequests jobs={[job]} agents={[]} selectedJob="all" messages={[]} />)
  await screen.findByText('Answer it in the chat app the agent asked in.')
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
})

test('a send-back without a note says what is missing and posts nothing', async () => {
  const exchange = makeExchange({
    pause: { reason: 'no_decision', options: ['send_back'] },
  })
  const fetchMock = stubRoom(exchange)
  renderInRoom(<RoomRequests jobs={[job]} agents={[]} selectedJob="all" messages={[]} />)

  fireEvent.click(await screen.findByRole('button', { name: 'Send back' }))
  fireEvent.click(screen.getByRole('button', { name: 'Send back' }))
  await screen.findByText('Write a short note for the author.')
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/decision'))).toBe(false)
})

test('a selected job shows only its own requests', async () => {
  stubRoom(makeExchange({ jobId: 'job-2' }))
  renderInRoom(<RoomRequests jobs={[job, other]} agents={[]} selectedJob="job-2" messages={[]} />)
  const exchange = await screen.findByRole('article', { name: /The exchange used its turns/ })
  expect(screen.queryByText('Activity feed')).toBeNull()
  expect(exchange.textContent).toContain('Release notes')
})

test('a non-actionable approval is history, not a request card', async () => {
  vi.stubGlobal(
    'fetch',
    mockFetch((url) => {
      if (url === '/api/approvals?status=all')
        return jsonResponse({
          asOfSeq: 1,
          items: [{ ...approval, actionable: false }],
          nextCursor: null,
        })
      return jsonResponse({ asOfSeq: 0, items: [] })
    }),
  )
  renderInRoom(
    <RoomRequests
      jobs={[job]}
      agents={[]}
      selectedJob="all"
      messages={[
        makeMessage({
          id: 'approval:approval-1',
          jobId: job.id,
          parts: [{ kind: 'approval', approvalId: approval.id }],
        }),
      ]}
    />,
  )
  await waitFor(() => expect(screen.queryByRole('article', { name: /May I install/ })).toBeNull())
})
