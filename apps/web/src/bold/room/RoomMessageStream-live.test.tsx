import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test } from 'vitest'
import type { StreamClient } from '../../data/stream.ts'
import { makeMessage } from './room-test-utils.tsx'
import {
  boldButton,
  pages,
  renderStream,
  setupRoomMessageStreamTest,
  stubLiveStream,
  stubStream,
} from './RoomMessageStream-helpers.tsx'

setupRoomMessageStreamTest()

test('Retry is offered on agent replies that answer the person, and posts to the contract endpoint', async () => {
  const fetchMock = stubStream({
    pages: {
      'job-1': [
        makeMessage({
          id: 'message-0',
          jobId: 'job-1',
          createdAt: '2026-10-24T09:00:00.000Z',
          parts: [{ kind: 'text', text: 'Build it.' }],
        }),
        makeMessage({
          id: 'message-1',
          jobId: 'job-1',
          author: { kind: 'agent', agentId: 'builder' },
          parts: [{ kind: 'text', text: 'Read layer is ready.' }],
        }),
        makeMessage({
          id: 'message-9',
          jobId: 'job-1',
          createdAt: '2026-10-24T09:02:00.000Z',
          author: { kind: 'agent', agentId: 'reviewer' },
          parts: [{ kind: 'text', text: 'Looks right.' }],
        }),
      ],
    },
  })
  renderStream()
  await screen.findByText('Read layer is ready.')
  // The reviewer also answers the person's message (it follows the builder's reply): Retry there too.
  expect(boldButton('Try another reply from reviewer')).toBeDefined()
  fireEvent.click(boldButton('Try another reply from builder'))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === '/api/rooms/room-1/messages/message-1/retry' && init?.method === 'POST',
      ),
    ).toBe(true),
  )
  expect(boldButton('Try another reply from builder').textContent).toContain('Asking')
})

test('a newly completed agent message is announced once, after history loads', async () => {
  const live = stubLiveStream({ pages: { 'job-1': pages['job-1'] ?? [], 'job-2': [] } })
  renderStream(false, null, () => undefined, live.stream as unknown as StreamClient)
  await screen.findByText('Read layer is ready.')
  const status = screen.getByRole('status')
  expect(status.textContent).toBe('')

  const fresh = makeMessage({
    id: 'message-fresh',
    jobId: 'job-1',
    author: { kind: 'agent', agentId: 'builder' },
    parts: [{ kind: 'text', text: 'The API is green.' }],
    createdAt: '2026-10-24T09:30:00.000Z',
  })
  act(() =>
    live.emit({
      type: 'message.created',
      data: fresh,
      seq: 2,
      ts: '2026-10-24T09:30:00.000Z',
    }),
  )
  expect(await screen.findByText('The API is green.')).toBeDefined()
  await waitFor(() => expect(status.textContent).toBe('New message from builder'), {
    timeout: 2500,
  })
})

test('the person’s own messages are never announced', async () => {
  const live = stubLiveStream({ pages: { 'job-1': pages['job-1'] ?? [], 'job-2': [] } })
  renderStream(false, null, () => undefined, live.stream as unknown as StreamClient)
  await screen.findByText('Read layer is ready.')
  const status = screen.getByRole('status')
  act(() =>
    live.emit({
      type: 'message.created',
      data: makeMessage({
        id: 'message-mine',
        jobId: 'job-1',
        parts: [{ kind: 'text', text: 'My own note.' }],
        createdAt: '2026-10-24T09:31:00.000Z',
      }),
      seq: 2,
      ts: '2026-10-24T09:31:00.000Z',
    }),
  )
  expect(await screen.findByText('My own note.')).toBeDefined()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(status.textContent).toBe('')
})

test('a message that only becomes visible (older than what was seen) is not announced as new', async () => {
  const live = stubLiveStream({ pages: { 'job-1': pages['job-1'] ?? [], 'job-2': [] } })
  renderStream(false, null, () => undefined, live.stream as unknown as StreamClient)
  await screen.findByText('Read layer is ready.')
  const status = screen.getByRole('status')
  // An earlier page, a tab switch or an undone delete brings back an old agent message: it isn't news.
  act(() =>
    live.emit({
      type: 'message.created',
      data: makeMessage({
        id: 'message-old',
        jobId: 'job-1',
        author: { kind: 'agent', agentId: 'builder' },
        parts: [{ kind: 'text', text: 'From this morning.' }],
        createdAt: '2026-10-01T08:00:00.000Z',
      }),
      seq: 2,
      ts: '2026-10-24T09:32:00.000Z',
    }),
  )
  expect(await screen.findByText('From this morning.')).toBeDefined()
  await new Promise((resolve) => setTimeout(resolve, 2200))
  expect(status.textContent).toBe('')
})
