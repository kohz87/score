import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test } from 'vitest'
import { agents, makeExchange, renderInRoom } from './room-test-utils.tsx'
import { roomExchangesQuery } from './room-queries.ts'
import {
  approval,
  deferred,
  job,
  setupRoomRequestsTest,
  stubRoom,
} from './RoomRequests-helpers.tsx'
import { RoomRequests } from './RoomRequests.tsx'

setupRoomRequestsTest()

test('send back asks for the note the exchange decision needs, then posts it', async () => {
  const exchange = makeExchange({
    pause: { reason: 'no_decision', options: ['send_back', 'close'] },
  })
  const decisionGate = deferred<void>()
  const fetchMock = stubRoom(exchange, approval, decisionGate.promise)
  const { queryClient } = renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={[]} selectedJob="all" messages={[]} />,
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

test('a send-back without a note says what is missing and posts nothing', async () => {
  const exchange = makeExchange({
    pause: { reason: 'no_decision', options: ['send_back'] },
  })
  const fetchMock = stubRoom(exchange)
  renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={[]} selectedJob="all" messages={[]} />,
  )

  fireEvent.click(await screen.findByRole('button', { name: 'Send back' }))
  fireEvent.click(screen.getByRole('button', { name: 'Send back' }))
  await screen.findByText('Write a short note for the author.')
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/decision'))).toBe(false)
})

test('the same read keeps the sent line; a newer read that still pauses brings the buttons back', async () => {
  const exchange = makeExchange({ pause: { reason: 'no_decision', options: ['send_back'] } })
  stubRoom(exchange)
  const { queryClient } = renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={[]} selectedJob="all" messages={[]} />,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Send back' }))
  fireEvent.change(screen.getByLabelText('Note for the author'), {
    target: { value: 'Add the migration steps.' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send back' }))
  await screen.findByText('Sent back with your note.')

  act(() =>
    queryClient.setQueryData(roomExchangesQuery([job.id]).key, {
      asOfSeq: 2,
      data: [{ ...exchange }],
    }),
  )
  await waitFor(() => expect(screen.getByText('Sent back with your note.')).toBeDefined())
  expect(screen.queryByRole('button', { name: 'Send back' })).toBeNull()

  act(() =>
    queryClient.setQueryData(roomExchangesQuery([job.id]).key, {
      asOfSeq: 3,
      data: [{ ...exchange, updatedAt: '2026-10-24T09:20:00.000Z' }],
    }),
  )
  expect(await screen.findByRole('button', { name: 'Send back' })).toBeDefined()
  expect(screen.queryByText('Sent back with your note.')).toBeNull()
})

test('a cleared or changed pause releases the exchange buttons again', async () => {
  const exchange = makeExchange({ pause: { reason: 'no_decision', options: ['send_back'] } })
  stubRoom(exchange)
  const { queryClient } = renderInRoom(
    <RoomRequests roomId="room-1" jobs={[job]} agents={[]} selectedJob="all" messages={[]} />,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Send back' }))
  fireEvent.change(screen.getByLabelText('Note for the author'), {
    target: { value: 'Add the migration steps.' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send back' }))
  await screen.findByText('Sent back with your note.')

  act(() =>
    queryClient.setQueryData(roomExchangesQuery([job.id]).key, {
      asOfSeq: 2,
      data: [{ ...exchange, pause: null, state: 'waiting_on_agent' }],
    }),
  )
  await waitFor(() => expect(screen.queryByText('Sent back with your note.')).toBeNull())

  act(() =>
    queryClient.setQueryData(roomExchangesQuery([job.id]).key, {
      asOfSeq: 3,
      data: [exchange],
    }),
  )
  expect(await screen.findByRole('button', { name: 'Send back' })).toBeDefined()
})

test('reassign starts on the first legal choice when its form opens', async () => {
  const exchange = makeExchange({ pause: { reason: 'unreachable', options: ['reassign'] } })
  const fetchMock = stubRoom(exchange)
  renderInRoom(<RoomRequests roomId="room-1" jobs={[job]} agents={agents} selectedJob="all" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Reassign' }))
  expect((screen.getByLabelText('Give the turn to') as HTMLSelectElement).value).toBe('lead')
  fireEvent.click(screen.getByRole('button', { name: 'Reassign' }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === '/api/exchanges/exchange-1/decision' && init?.method === 'POST',
      ),
    ).toBe(true),
  )
})

test('more spend rejects 0, more than 1000 and non-numbers with one clear message', async () => {
  const exchange = makeExchange({ pause: { reason: 'spend_cap', options: ['more_spend'] } })
  const fetchMock = stubRoom(exchange)
  renderInRoom(<RoomRequests roomId="room-1" jobs={[job]} agents={[]} selectedJob="all" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Allow more spend' }))
  for (const value of ['0', '1000.01', '']) {
    fireEvent.change(screen.getByLabelText('More spend in dollars'), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: 'Allow more spend' }))
    await screen.findByText('Enter an amount above 0 and at most 1000 dollars.')
  }
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/decision'))).toBe(false)
})

test('the more-turns button never shows an empty count', async () => {
  const exchange = makeExchange()
  stubRoom(exchange)
  renderInRoom(<RoomRequests roomId="room-1" jobs={[job]} agents={[]} selectedJob="all" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Give 4 more turns' }))
  fireEvent.change(screen.getByLabelText('More turns (1–20)'), { target: { value: '' } })
  expect(screen.getByRole('button', { name: 'Give more turns' })).toBeDefined()
  expect(screen.queryByRole('button', { name: /Give {2}more turns/ })).toBeNull()
})
