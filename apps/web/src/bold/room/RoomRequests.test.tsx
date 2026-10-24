import type { Approval, Exchange } from '@score/contract'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
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

function stubRoom(exchange: Exchange | null, decided = approval) {
  const fetchMock = mockFetch((url, init) => {
    if (url === '/api/approvals?status=all') {
      if (init.method === 'POST') throw new Error('not the approvals list')
      return jsonResponse({ asOfSeq: 1, items: [approval], nextCursor: null })
    }
    if (url === '/api/approvals/approval-1/decision')
      return jsonResponse({
        ...approval,
        ...decided,
        phase: 'decided',
        status: 'approved',
        actionable: false,
        decision: { choice: 'once', by: 'you', at: '2026-10-24T09:05:00.000Z' },
        delivery: 'applied',
      })
    if (url.startsWith('/api/jobs/')) {
      const items = exchange && url.includes(exchange.jobId) ? [exchange] : []
      return jsonResponse({ asOfSeq: 1, items })
    }
    return jsonResponse({ asOfSeq: 0, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

test('an approval and a paused exchange are protected decision cards with their job', async () => {
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

  const exchangeCard = await screen.findByRole('article', {
    name: /The exchange used its turns/,
  })
  expect(exchangeCard.getAttribute('data-protected')).toBe('flex')
  expect(exchangeCard.textContent).toContain('8 of 8 turns')
})

test('Allow sends the approval decision once and shows the resolved choice', async () => {
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

  fireEvent.click(await screen.findByRole('button', { name: 'Allow' }))
  await screen.findByText('Approved by you')
  const post = fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url) === '/api/approvals/approval-1/decision' && init?.method === 'POST',
  )
  expect(post).toBeDefined()
  expect(JSON.parse(String(post![1]!.body))).toEqual({ choice: 'once' })
})

test('send back asks for the note the exchange decision needs, then posts it', async () => {
  const exchange = makeExchange({
    pause: { reason: 'no_decision', options: ['send_back', 'close'] },
  })
  const fetchMock = stubRoom(exchange)
  renderInRoom(<RoomRequests jobs={[job]} agents={[]} selectedJob="all" messages={[]} />)

  fireEvent.click(await screen.findByRole('button', { name: 'Send back' }))
  const note = screen.getByLabelText('Note for the author')
  fireEvent.change(note, { target: { value: 'Add the migration steps.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send back' }))

  await screen.findByText('Sent back with your note.')
  const post = fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url) === '/api/exchanges/exchange-1/decision' && init?.method === 'POST',
  )
  expect(post).toBeDefined()
  expect(JSON.parse(String(post![1]!.body))).toEqual({
    option: 'send_back',
    note: 'Add the migration steps.',
  })
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
