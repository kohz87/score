import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { approvalsQuery } from '../../routes/chat/queries.ts'
import { fenceKey } from '../../routes/orchestrations/orchestration-queries.ts'
import {
  agents,
  jsonResponse,
  makeExchange,
  makeJob,
  makeMessage,
  mockFetch,
  renderInRoom,
} from './room-test-utils.tsx'
import { approval, job, other, setupRoomRequestsTest, stubRoom } from './RoomRequests-helpers.tsx'
import { RoomRequests } from './RoomRequests.tsx'

setupRoomRequestsTest()

test('an approval leads the pins, every other card shows beneath it with no fold, and all are protected', async () => {
  stubRoom(makeExchange())
  renderInRoom(
    <RoomRequests
      roomId="room-1"
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

  // 3.24.0: no pinned strip (and so no "N more below" cue); the cards sit in the conversation's slots.
  expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull()
  expect(document.querySelector('.bold-pins, .bold-pins-more')).toBeNull()
  expect(screen.queryByRole('button', { name: /more needs? you|Show fewer/ })).toBeNull()

  const exchangeCard = await screen.findByRole('article', {
    name: /The exchange used its turns/,
  })
  expect(exchangeCard.getAttribute('data-protected')).toBe('flex')
  expect(exchangeCard.textContent).toContain('8 of 8 turns')
})

test('a global fence is a protected review card, and the card goes when the fence lifts', async () => {
  stubRoom(null, approval, Promise.resolve(), true)
  const { queryClient } = renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={[]} selectedJob="all" messages={[]} />,
  )
  const card = await screen.findByRole('article', {
    name: /Starting work is blocked until you review the runs it stopped/,
  })
  expect(card.getAttribute('data-protected')).toBe('flex')
  // The fence is one card among the others: with the approval also waiting, both show and nothing folds.
  expect(await screen.findByRole('article', { name: /May I install a package/ })).toBeDefined()
  expect(screen.queryByRole('button', { name: /more needs? you/ })).toBeNull()
  expect(screen.getByRole('link', { name: 'Review the runs' }).getAttribute('href')).toBe(
    '/b/settings/system#global-fence',
  )

  act(() =>
    queryClient.setQueryData(fenceKey, {
      fenced: false,
      reason: null,
      untrustedHistory: false,
      revision: 2,
      since: null,
      items: [],
      journal: { ok: true, entries: 4, bytes: 1200, sizeAlarm: false },
    }),
  )
  await waitFor(() =>
    expect(
      screen.queryByRole('article', {
        name: /Starting work is blocked until you review the runs it stopped/,
      }),
    ).toBeNull(),
  )
})

test('a selected job shows only its own requests', async () => {
  stubRoom(makeExchange({ jobId: 'job-2' }))
  renderInRoom(
    <RoomRequests
      roomId="room-1"
      jobs={[job, other]}
      agents={[]}
      selectedJob="job-2"
      messages={[]}
    />,
  )
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
  await waitFor(() => expect(screen.queryByRole('article', { name: /May I install/ })).toBeNull())
})

test('an approval for another room stays out of this room’s strip', async () => {
  vi.stubGlobal(
    'fetch',
    mockFetch((url) => {
      if (url === '/api/approvals?status=all')
        return jsonResponse({
          asOfSeq: 1,
          items: [{ ...approval, refs: [{ kind: 'room', roomId: 'room-2' }] }],
          nextCursor: null,
        })
      return jsonResponse({ asOfSeq: 0, items: [] })
    }),
  )
  renderInRoom(<RoomRequests roomId="room-1" jobs={[job]} agents={agents} selectedJob="all" />)
  await waitFor(() => expect(screen.queryByRole('article', { name: /May I install/ })).toBeNull())
})

test('an approval without a loaded message gets no invented job chip', async () => {
  vi.stubGlobal(
    'fetch',
    mockFetch((url) => {
      if (url === '/api/approvals?status=all')
        return jsonResponse({ asOfSeq: 1, items: [approval], nextCursor: null })
      return jsonResponse({ asOfSeq: 0, items: [] })
    }),
  )
  renderInRoom(<RoomRequests roomId="room-1" jobs={[job, other]} agents={[]} selectedJob="job-2" />)
  const card = await screen.findByRole('article', { name: /May I install a package/ })
  expect(card.textContent).not.toContain('Release notes')
  expect(card.textContent).not.toContain('Activity feed')
  expect(card.querySelector('.bold-request-job')).toBeNull()
})

test('the strip announces the first need and repeats the same count after it drops', async () => {
  stubRoom(null, approval, Promise.resolve(), false, [], [])
  const { queryClient } = renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={[]} selectedJob="all" messages={[]} />,
  )
  // The first status region is the strip's count; questions have their own.
  const status = screen.getAllByRole('status')[0]!
  expect(status.textContent).toBe('')
  await waitFor(() => expect(queryClient.getQueryState(approvalsQuery.key)?.status).toBe('success'))

  // 0 → 1: the always-mounted status region hears its first change.
  act(() =>
    queryClient.setQueryData(approvalsQuery.key, {
      asOfSeq: 2,
      data: [approval],
    }),
  )
  await waitFor(() => expect(status.textContent).toBe('1 need you'))

  // 1 → 2 announces the new total.
  act(() =>
    queryClient.setQueryData(approvalsQuery.key, {
      asOfSeq: 3,
      data: [approval, { ...approval, id: 'approval-2' }],
    }),
  )
  await waitFor(() => expect(status.textContent).toBe('2 need you'))

  // 2 → 1 clears the text; 1 → 2 can then announce the same sentence again.
  act(() =>
    queryClient.setQueryData(approvalsQuery.key, {
      asOfSeq: 4,
      data: [approval],
    }),
  )
  await waitFor(() => expect(status.textContent).toBe(''))
  act(() =>
    queryClient.setQueryData(approvalsQuery.key, {
      asOfSeq: 5,
      data: [approval, { ...approval, id: 'approval-2' }],
    }),
  )
  await waitFor(() => expect(status.textContent).toBe('2 need you'))
})

test('a room with nothing waiting renders no Needs-you region', async () => {
  stubRoom(null, approval)
  const { queryClient } = renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={[]} selectedJob="all" messages={[]} />,
  )
  await screen.findByRole('article', { name: /May I install a package/ })
  act(() => queryClient.setQueryData(approvalsQuery.key, { asOfSeq: 2, data: [] }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull())
})

test('report-back decisions are protected cards counted with the strip', async () => {
  const fetchMock = stubRoom(null, approval)
  const fallback = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url, init) => {
    if (url === '/api/jobs/job-2/report-back' && init?.method === 'POST')
      return jsonResponse({ ok: true })
    return fallback(url, init)
  })
  const source = {
    app: 'Tickets app',
    ref: 'TCK-142',
    title: 'Login times out',
    link: null,
    triggerId: 'trigger-1',
    missing: [],
  }
  const needsOk = makeJob({
    id: 'job-2',
    title: 'Release notes',
    source,
    reportBack: { state: 'needs_ok', tool: 'add_comment', at: null },
  })
  const notConfirmed = makeJob({
    id: 'job-3',
    title: 'Queue research',
    source,
    reportBack: { state: 'not_confirmed', tool: 'add_comment', at: null },
  })
  renderInRoom(
    <RoomRequests
      roomId="room-1"
      jobs={[job, needsOk, notConfirmed]}
      agents={agents}
      selectedJob="all"
      messages={[]}
    />,
  )

  const cards = await screen.findAllByRole('article', { name: /Report back:/ })
  expect(cards).toHaveLength(2)
  expect(cards.every((card) => card.getAttribute('data-protected') === 'flex')).toBe(true)
  expect(screen.queryByRole('button', { name: /more needs? you/ })).toBeNull()
  const card = screen.getByRole('article', { name: 'Needs you: Report back: Release notes' })
  fireEvent.click(within(card).getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === '/api/jobs/job-2/report-back' && init?.method === 'POST',
      ),
    ).toBe(true),
  )
})
