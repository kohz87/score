import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { approvalsQuery } from '../../routes/chat/queries.ts'
import { jsonResponse, makeMessage, mockFetch, renderInRoom } from './room-test-utils.tsx'
import {
  approval,
  deferred,
  job,
  resolvedApproval,
  setupRoomRequestsTest,
  stubRoom,
} from './RoomRequests-helpers.tsx'
import { RoomRequests } from './RoomRequests.tsx'

setupRoomRequestsTest()

test('Allow sends the approval decision once and the answered card goes', async () => {
  const decisionGate = deferred<void>()
  const fetchMock = stubRoom(null, approval, decisionGate.promise)
  const { queryClient } = renderInRoom(
    <RoomRequests
      roomId="room-1"
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

test('More offers this session and always for the asking agent', async () => {
  const fetchMock = stubRoom(null)
  renderInRoom(
    <RoomRequests
      roomId="room-1"
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
  renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={[]} selectedJob="all" messages={[]} />,
  )
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
  renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={[]} selectedJob="all" messages={[]} />,
  )
  await screen.findByText('Answer it in the chat app the agent asked in.')
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
})
