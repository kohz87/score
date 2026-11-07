import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { StreamClient } from '../../data/stream.ts'
import { agents, jsonResponse, makeJob, makeMessage, renderInRoom } from './room-test-utils.tsx'
import { RoomMessageStream } from './RoomMessageStream.tsx'
import {
  setupRoomMessageStreamTest,
  stubLiveStream,
  stubStream,
} from './RoomMessageStream-helpers.tsx'

setupRoomMessageStreamTest()

// 3.22.0: the merged conversation.
const general = makeJob({
  id: 'general',
  title: 'General',
  isDefault: true,
  state: 'open',
  createdAt: '2026-10-24T08:00:00.000Z',
})
const feed = makeJob({
  id: 'job-1',
  title: 'Activity feed',
  state: 'working',
  createdAt: '2026-10-24T09:00:00.000Z',
})
const notes = makeJob({
  id: 'job-2',
  title: 'Release notes',
  state: 'done',
  createdAt: '2026-10-24T09:30:00.000Z',
})
const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00.000Z`
const say = (id: string, jobId: string, minute: number, text: string) =>
  makeMessage({
    id,
    jobId,
    createdAt: at(minute),
    parts: [{ kind: 'text', text }],
  })
const topicPages = {
  general: [
    say('g-1', 'general', 1, 'Morning, team.'),
    say('g-2', 'general', 6, 'Back to general.'),
  ],
  'job-1': [
    say('f-1', 'job-1', 2, 'Feed first.'),
    say('f-2', 'job-1', 3, 'Feed second.'),
    say('f-3', 'job-1', 7, 'Feed again.'),
  ],
  'job-2': [say('n-1', 'job-2', 4, 'Notes first.')],
}

function renderTopics(stream?: StreamClient, focusTopic: string | null = null) {
  return renderInRoom(
    <RoomMessageStream
      roomId="room-1"
      jobs={[general, feed, notes]}
      agents={agents}
      showDeleted={false}
      seek={null}
      onSeeked={() => undefined}
      focusTopic={focusTopic}
    />,
    ['/b?room=room-1'],
    stream,
  )
}

test('the merged stream is in time order across topics, whatever order the pages arrive in', async () => {
  stubStream({ pages: topicPages })
  renderTopics()
  await screen.findByText('Morning, team.')
  const text = document.querySelector('.bold-stream')!.textContent ?? ''
  const order = [
    'Morning, team.',
    'Feed first.',
    'Feed second.',
    'Notes first.',
    'Back to general.',
    'Feed again.',
  ].map((line) => text.indexOf(line))
  expect(order.every((index) => index >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
})

test('a divider opens each topic, none opens the general conversation, and a return is marked', async () => {
  stubStream({ pages: topicPages })
  renderTopics()
  await screen.findByText('Morning, team.')
  const dividers = screen.getAllByRole('separator').map((item) => item.getAttribute('aria-label'))
  expect(dividers).toEqual([
    'Topic: Activity feed, working',
    'Topic: Release notes, done',
    'General conversation',
    'Topic: Activity feed, working',
  ])
  expect(document.querySelector('.bold-stream')!.firstElementChild?.getAttribute('role')).not.toBe(
    'separator',
  )
  expect(screen.getByText(/Back to topic/)).toBeDefined()
})

test('the current topic’s divider scrolls into view when it is picked', async () => {
  stubStream({ pages: topicPages })
  const scroll = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scroll,
  })
  try {
    renderTopics(undefined, 'job-2')
    await screen.findByText('Notes first.')
    await waitFor(() => expect(scroll).toHaveBeenCalled())
    expect(scroll.mock.contexts[0]).toBe(document.getElementById('topic-job-2'))
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
})

test('Load earlier pages the one chain back through every topic', async () => {
  const fetchMock = stubStream({ pages: topicPages })
  const base = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = new URL(String(input), 'http://x')
    if (parsed.pathname === '/api/rooms/room-1/messages') {
      const earlier = parsed.searchParams.get('before') === 'cursor-older'
      return Promise.resolve(
        jsonResponse({
          asOfSeq: 1,
          items: earlier
            ? [say('n-0', 'job-2', 0, 'Notes before everything.')]
            : Object.values(topicPages).flat(),
          nextCursor: earlier ? null : 'cursor-older',
          jobId: null,
        }),
      )
    }
    return base(input, init)
  })
  renderTopics()
  await screen.findByText('Morning, team.')
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
  expect(await screen.findByText('Notes before everything.')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull()
  // The earlier message came from the older page and sits first, under its own topic’s divider.
  const first = document.querySelector('.bold-stream')!.textContent ?? ''
  expect(first.indexOf('Notes before everything.')).toBeLessThan(first.indexOf('Morning, team.'))
})

test('a live message from another topic merges into the same conversation in time order', async () => {
  const live = stubLiveStream({ pages: topicPages })
  renderTopics(live.stream as unknown as StreamClient)
  await screen.findByText('Morning, team.')
  act(() =>
    live.emit({
      type: 'message.created',
      data: say('n-2', 'job-2', 8, 'Notes arrived live.'),
      seq: 2,
      ts: at(8),
    }),
  )
  expect(await screen.findByText('Notes arrived live.')).toBeDefined()
  const text = document.querySelector('.bold-stream')!.textContent ?? ''
  expect(text.indexOf('Notes arrived live.')).toBeGreaterThan(text.indexOf('Feed again.'))
  // Returning to the notes topic after the feed topic gets its own marker.
  expect(
    screen
      .getAllByRole('separator')
      .map((item) => item.getAttribute('aria-label'))
      .at(-1),
  ).toBe('Topic: Release notes, done')
})

test('one job per chat: no topic dividers (the stream is one conversation), the job’s anchor and run card stay', async () => {
  stubStream({ pages: topicPages })
  const withRun = { ...feed, recipe: { kind: 'orchestration' as const, ref: 'orch-1' } }
  renderInRoom(
    <RoomMessageStream
      roomId="room-1"
      jobs={[general, withRun, notes]}
      agents={agents}
      showDeleted={false}
      seek={null}
      onSeeked={() => undefined}
      onShowGraph={() => undefined}
      oneJobPerChat
    />,
  )
  await screen.findByText('Morning, team.')
  expect(screen.queryAllByRole('separator')).toEqual([])
  expect(screen.queryByText(/Back to topic/)).toBeNull()
  expect(screen.queryByText(/Topic ·/)).toBeNull()
  // Its anchor is where "scroll to this job" lands; the run card is still drawn.
  expect(document.getElementById('topic-job-1')).not.toBeNull()
  expect(await screen.findByRole('button', { name: 'Show graph' })).toBeDefined()
})

test('an older chat that still holds several active jobs keeps its dividers', async () => {
  stubStream({ pages: topicPages })
  const second = { ...notes, state: 'working' as const }
  renderInRoom(
    <RoomMessageStream
      roomId="room-1"
      jobs={[general, feed, second]}
      agents={agents}
      showDeleted={false}
      seek={null}
      onSeeked={() => undefined}
      oneJobPerChat
    />,
  )
  await screen.findByText('Morning, team.')
  expect(screen.getAllByRole('separator').length).toBeGreaterThan(1)
  expect(screen.getByText(/Back to topic/)).toBeDefined()
})
