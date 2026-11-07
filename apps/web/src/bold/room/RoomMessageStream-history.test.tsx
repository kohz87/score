import type { RoomVersion } from '@score/contract'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { jsonResponse, makeMessage } from './room-test-utils.tsx'
import {
  pages,
  renderStream,
  setupRoomMessageStreamTest,
  stubStream,
} from './RoomMessageStream-helpers.tsx'

setupRoomMessageStreamTest()

test('a seek target gets the hit marker after its message has loaded', async () => {
  stubStream()
  renderStream(false, 'message-2')
  await screen.findByText('Add ws.')
  await waitFor(() =>
    expect(
      document.getElementById('message-message-2')?.classList.contains('bold-message-hit'),
    ).toBe(true),
  )
})

test('a seek to a version hidden in a reply group selects it there, then highlights it', async () => {
  const first = makeMessage({
    id: 'g-1',
    jobId: 'job-1',
    createdAt: '2026-10-24T09:01:00.000Z',
    author: { kind: 'agent', agentId: 'builder' },
    parts: [{ kind: 'text', text: 'First answer.' }],
  })
  const second = makeMessage({
    id: 'g-2',
    jobId: 'job-1',
    createdAt: '2026-10-24T09:02:00.000Z',
    alternativeOf: 'g-1',
    author: { kind: 'agent', agentId: 'builder' },
    parts: [{ kind: 'text', text: 'Second answer.' }],
  })
  stubStream({ pages: { 'job-1': [first, second], 'job-2': [] } })
  const onSeeked = vi.fn()
  window.localStorage.clear()
  renderStream(false, 'g-1', onSeeked)
  await waitFor(() => expect(onSeeked).toHaveBeenCalled())
  expect(document.getElementById('message-g-1')?.classList.contains('bold-message-hit')).toBe(true)
  expect(screen.getByText('1 / 2')).toBeDefined()
})

test('show deleted reads the version and shows the deleted messages of every topic', async () => {
  const version: RoomVersion = {
    id: 'version-1',
    roomId: 'room-1',
    anchorId: 'anchor-1',
    anchorCreatedAt: '2026-10-24T09:01:00.000Z',
    mode: 'delete',
    replacedBy: null,
    number: 1,
    count: 1,
    hiddenCount: 2,
    rewound: [],
    skipped: [],
    createdAt: '2026-10-24T09:02:00.000Z',
  }
  const hiddenOne = makeMessage({
    id: 'hidden-one',
    jobId: 'job-1',
    parts: [{ kind: 'text', text: 'Activity feed hidden message.' }],
  })
  const hiddenTwo = makeMessage({
    id: 'hidden-two',
    jobId: 'job-2',
    parts: [{ kind: 'text', text: 'Release notes hidden message.' }],
  })
  const fetchMock = stubStream({ pages: { 'job-1': [], 'job-2': [] }, versions: [version] })
  // The version detail read is the one that holds the hidden messages.
  const base = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/versions/anchor-1'))
      return Promise.resolve(jsonResponse({ version, items: [hiddenOne, hiddenTwo] }))
    return base(input, init)
  })

  renderStream(true)
  await screen.findByText('Activity feed hidden message.')
  expect(screen.getByText('Release notes hidden message.')).toBeDefined()
  expect(screen.getByText(/Deleted, read-only. 2 hidden messages/)).toBeDefined()
})

test('3.22.0: the deleted-messages block shows once in a chat of several topics, not once per topic run', async () => {
  const version: RoomVersion = {
    id: 'version-1',
    roomId: 'room-1',
    anchorId: 'anchor-1',
    anchorCreatedAt: '2000-01-01T00:00:00.000Z',
    mode: 'delete',
    replacedBy: null,
    number: 1,
    count: 1,
    hiddenCount: 1,
    rewound: [],
    skipped: [],
    createdAt: '2000-01-01T00:01:00.000Z',
  }
  stubStream({ versions: [version] })
  renderStream(true)
  await screen.findByText('Drafted the 2.4 notes.')
  await waitFor(() => expect(screen.getAllByTestId('deleted-messages')).toHaveLength(1))
})

test('an edited message’s version control opens the older read-only branch', async () => {
  const version: RoomVersion = {
    id: 'version-1',
    roomId: 'room-1',
    anchorId: 'message-old',
    anchorCreatedAt: '2026-10-24T08:00:00.000Z',
    mode: 'edit',
    replacedBy: 'message-new',
    number: 1,
    count: 2,
    hiddenCount: 1,
    rewound: [],
    skipped: [],
    createdAt: '2026-10-24T08:01:00.000Z',
  }
  const original = makeMessage({
    id: 'message-old',
    jobId: 'job-1',
    parts: [{ kind: 'text', text: 'First wording.' }],
  })
  const corrected = makeMessage({
    id: 'message-new',
    jobId: 'job-1',
    parts: [{ kind: 'text', text: 'Corrected wording.' }],
  })
  const fetchMock = stubStream({
    pages: { 'job-1': [corrected], 'job-2': [] },
    versions: [version],
  })
  const base = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/versions/message-old'))
      return Promise.resolve(jsonResponse({ version, items: [original] }))
    return base(input, init)
  })
  renderStream()
  await screen.findByText('Corrected wording.')
  const control = screen.getByRole('group', { name: 'Message versions' })
  expect(control.textContent).toContain('2 / 2')
  fireEvent.click(screen.getByRole('button', { name: 'Previous version' }))
  expect(await screen.findByText(/Viewing version 1 of 2/)).toBeDefined()
  expect(await screen.findByText('First wording.')).toBeDefined()
})

const olderMessage = makeMessage({
  id: 'message-older',
  jobId: 'job-1',
  author: { kind: 'agent', agentId: 'builder' },
  parts: [{ kind: 'text', text: 'Older history.' }],
  createdAt: '2026-10-24T07:00:00.000Z',
})

function stubPagedHistory() {
  const fetchMock = stubStream({ pages: { 'job-1': pages['job-1']!, 'job-2': [] } })
  const base = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = new URL(String(input), 'http://x')
    if (parsed.pathname === '/api/rooms/room-1/messages') {
      const before = parsed.searchParams.get('before')
      return Promise.resolve(
        jsonResponse({
          asOfSeq: 1,
          items: before === 'cursor-older' ? [olderMessage] : pages['job-1'],
          nextCursor: before === 'cursor-older' ? null : 'cursor-older',
          jobId: null,
        }),
      )
    }
    return base(input, init)
  })
  return fetchMock
}

test('Load earlier asks the chat’s one chain for the page before its first page', async () => {
  const fetchMock = stubPagedHistory()
  renderStream()
  await screen.findByText('Read layer is ready.')
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
  expect(await screen.findByText('Older history.')).toBeDefined()
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) =>
        String(url).includes('before=cursor-older') &&
        String(url).includes('all=1') &&
        (init?.method ?? 'GET') === 'GET',
    ),
  ).toBe(true)
})

test('a deep ?message= target loads older pages until it is found and is revealed', async () => {
  const fetchMock = stubPagedHistory()
  const onSeeked = vi.fn()
  renderStream(false, 'message-older', onSeeked)
  expect(await screen.findByText('Older history.')).toBeDefined()
  await waitFor(() =>
    expect(
      document.getElementById('message-message-older')?.classList.contains('bold-message-hit'),
    ).toBe(true),
  )
  expect(onSeeked).toHaveBeenCalled()
  expect(
    fetchMock.mock.calls.filter(([url]) => String(url).includes('before=cursor-older')),
  ).toHaveLength(1)
})

test('a ?message= target that is not in the history says it could not be found', async () => {
  stubStream({ pages: { 'job-1': pages['job-1']!, 'job-2': [] } })
  renderStream(false, 'message-gone')
  expect(
    await screen.findByText('Couldn’t find that message. It may have been deleted or moved.'),
  ).toBeDefined()
})
