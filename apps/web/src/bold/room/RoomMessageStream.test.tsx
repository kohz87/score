import type { Message, RoomVersion, StreamEvent } from '@score/contract'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeJob,
  makeMessage,
  mockFetch,
  renderInRoom,
} from './room-test-utils.tsx'
import type { StreamClient } from '../../data/stream.ts'
import { RoomMessageStream } from './RoomMessageStream.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const jobs = [
  makeJob({ id: 'job-1', title: 'Activity feed', state: 'working' }),
  makeJob({ id: 'job-2', title: 'Release notes', state: 'working' }),
]
const pages: Record<string, Message[]> = {
  'job-1': [
    makeMessage({
      id: 'message-1',
      jobId: 'job-1',
      author: { kind: 'agent', agentId: 'builder' },
      parts: [{ kind: 'text', text: 'Read layer is ready.' }],
    }),
    makeMessage({ id: 'message-2', jobId: 'job-1', parts: [{ kind: 'text', text: 'Add ws.' }] }),
  ],
  'job-2': [
    makeMessage({
      id: 'message-3',
      jobId: 'job-2',
      author: { kind: 'agent', agentId: 'reviewer' },
      parts: [{ kind: 'text', text: 'Drafted the 2.4 notes.' }],
    }),
  ],
}

function stubStream(options: { pages?: Record<string, Message[]>; versions?: RoomVersion[] } = {}) {
  const byJob = options.pages ?? pages
  const fetchMock = mockFetch((url, init) => {
    const parsed = new URL(url, 'http://x')
    if (parsed.pathname === '/api/rooms/room-1/messages') {
      const jobId = parsed.searchParams.get('jobId') ?? ''
      return jsonResponse({
        asOfSeq: 1,
        items: byJob[jobId] ?? [],
        nextCursor: null,
        jobId,
      })
    }
    if (parsed.pathname === '/api/rooms/room-1/pins')
      return jsonResponse({
        items: [
          {
            messageId: 'message-1',
            text: 'Read layer is ready.',
            pinnedAt: '2026-10-24T09:00:00.000Z',
          },
        ],
      })
    if (parsed.pathname === '/api/rooms/room-1/versions')
      return jsonResponse({ asOfSeq: 1, items: options.versions ?? [] })
    if (parsed.pathname.startsWith('/api/rooms/room-1/pins/'))
      return new Response(null, { status: 204 })
    if (parsed.pathname.startsWith('/api/rooms/room-1/versions/')) {
      const version = (options.versions ?? []).find((item) =>
        parsed.pathname.endsWith(`/versions/${item.anchorId}`),
      )
      return jsonResponse({ version, items: [] })
    }
    if (parsed.pathname.startsWith('/api/rooms/room-1/rewind'))
      return jsonResponse({ hiddenCount: 1, agents: [], blocked: null })
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    return jsonResponse({ asOfSeq: 1, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function stubLiveStream(options: { pages?: Record<string, Message[]> } = {}) {
  const byJob = options.pages ?? pages
  const listeners = new Set<(event: StreamEvent) => void>()
  const fetchMock = mockFetch((url) => {
    const parsed = new URL(url, 'http://x')
    if (parsed.pathname === '/api/rooms/room-1/messages') {
      const jobId = parsed.searchParams.get('jobId') ?? ''
      return jsonResponse({
        asOfSeq: 1,
        items: byJob[jobId] ?? [],
        nextCursor: null,
        jobId,
      })
    }
    if (parsed.pathname === '/api/rooms/room-1/pins')
      return jsonResponse({ items: [], revision: 0 })
    if (parsed.pathname === '/api/rooms/room-1/versions')
      return jsonResponse({ asOfSeq: 1, items: [] })
    return jsonResponse({ asOfSeq: 1, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    // The fixture's message type carries optional fields the contract's inferred type spells differently.
    emit(event: unknown) {
      for (const listener of listeners) listener(event as StreamEvent)
    },
    stream: {
      subscribe(listener: (event: StreamEvent) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      onControl: () => () => undefined,
    },
  }
}

function renderStream(
  selectedJob = 'all',
  showDeleted = false,
  seek: string | null = null,
  onSeeked: () => void = () => undefined,
  stream?: StreamClient,
) {
  return renderInRoom(
    <RoomMessageStream
      roomId="room-1"
      jobs={jobs}
      agents={[]}
      selectedJob={selectedJob}
      filter="all"
      showDeleted={showDeleted}
      seek={seek}
      openedJobs={[]}
      onRevealSeek={() => undefined}
      onSeeked={onSeeked}
    />,
    ['/b?room=room-1'],
    stream,
  )
}

function boldButton(name: RegExp | string) {
  const button = screen
    .getAllByRole('button', { name })
    .find((element) => element.classList.contains('bold-act'))
  if (!button) throw new Error(`No bold action button named ${String(name)}`)
  return button
}

test('All folds every job’s messages and a job shows only its own', async () => {
  stubStream()
  const rendered = renderStream()
  await screen.findByText('Read layer is ready.')
  expect(screen.getByText('Add ws.')).toBeDefined()
  expect(screen.getByText('Drafted the 2.4 notes.')).toBeDefined()
  rendered.unmount()

  renderStream('job-2')
  await screen.findByText('Drafted the 2.4 notes.')
  expect(screen.queryByText('Read layer is ready.')).toBeNull()
  expect(screen.queryByText('Add ws.')).toBeNull()
})

test('the hover row pins and unpins through the contract, and keeps the state pressed', async () => {
  const fetchMock = stubStream()
  renderStream()
  await screen.findByText('Read layer is ready.')

  const unpin = await waitFor(() => boldButton('Unpin message from builder'))
  expect(unpin.getAttribute('aria-pressed')).toBe('true')
  const pin = boldButton('Pin message from You')
  fireEvent.click(pin)
  await waitFor(() => boldButton('Unpin message from You'))
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) =>
        String(url) === '/api/rooms/room-1/pins/message-2' && init?.method === 'POST',
    ),
  ).toBe(true)

  fireEvent.click(boldButton('Unpin message from You'))
  await waitFor(() => boldButton('Pin message from You'))
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) =>
        String(url) === '/api/rooms/room-1/pins/message-2' && init?.method === 'DELETE',
    ),
  ).toBe(true)
})

test('copy puts the message text on the clipboard and confirms it', async () => {
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  stubStream()
  renderStream()
  await screen.findByText('Read layer is ready.')
  fireEvent.click(boldButton('Copy message from builder'))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('Read layer is ready.'))
  expect(boldButton('Copy message from builder').textContent).toBe('Copied')
})

test('an agent reply offers Save to Library and opens the Library save dialog', async () => {
  stubStream()
  renderStream()
  await screen.findByText('Read layer is ready.')
  fireEvent.click(boldButton('Save message from builder to Library'))
  expect(await screen.findByRole('dialog', { name: 'Save to Knowledge' })).toBeDefined()
  expect(screen.getByText('This reply as a note')).toBeDefined()
})

test('your own message offers edit and delete; the delete asks for a rewind', async () => {
  stubStream()
  renderStream()
  await screen.findByText('Add ws.')
  expect(boldButton('Edit message from You')).toBeDefined()
  fireEvent.click(boldButton('Delete message from You'))
  expect(await screen.findByRole('dialog', { name: 'Delete this message?' })).toBeDefined()
})

test('a done job gets a result card linked to its latest agent message', async () => {
  const done = makeJob({
    id: 'job-done',
    title: 'Queue research',
    state: 'done',
    holderAgentId: 'lead',
  })
  stubStream({
    pages: {
      ...pages,
      'job-done': [
        makeMessage({
          id: 'message-done',
          jobId: 'job-done',
          author: { kind: 'agent', agentId: 'lead' },
          parts: [{ kind: 'text', text: 'Three queues compared.' }],
        }),
      ],
    },
  })
  renderInRoom(
    <RoomMessageStream
      roomId="room-1"
      jobs={[...jobs, done]}
      agents={agents}
      selectedJob="all"
      filter="all"
      showDeleted={false}
      seek={null}
      openedJobs={[]}
      onRevealSeek={() => undefined}
      onSeeked={() => undefined}
    />,
  )
  const result = await screen.findByRole('link', { name: 'Open result: Queue research' })
  expect(result.getAttribute('href')).toBe('/b?job=job-done&message=message-done')
  expect(result.textContent).toContain('Queue research')
  expect(result.textContent).toContain('Done · lead')
})

test('a seek target gets the hit marker after its message has loaded', async () => {
  stubStream()
  renderStream('all', false, 'message-2')
  await screen.findByText('Add ws.')
  await waitFor(() =>
    expect(
      document.getElementById('message-message-2')?.classList.contains('bold-message-hit'),
    ).toBe(true),
  )
})

test('show deleted reads the version and hides another job’s messages from a selected job', async () => {
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

  renderStream('job-1', true)
  await screen.findByText('Activity feed hidden message.')
  expect(screen.queryByText('Release notes hidden message.')).toBeNull()
  expect(screen.getByText(/Deleted, read-only. 2 hidden messages/)).toBeDefined()
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
  renderStream('job-1')
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
          jobId: parsed.searchParams.get('jobId'),
        }),
      )
    }
    return base(input, init)
  })
  return fetchMock
}

test('Load earlier asks for the page before the job’s first page', async () => {
  const fetchMock = stubPagedHistory()
  renderStream('job-1')
  await screen.findByText('Read layer is ready.')
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
  expect(await screen.findByText('Older history.')).toBeDefined()
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) =>
        String(url).includes('before=cursor-older') &&
        String(url).includes('jobId=job-1') &&
        (init?.method ?? 'GET') === 'GET',
    ),
  ).toBe(true)
})

test('a deep ?message= target loads older pages until it is found and is revealed', async () => {
  const fetchMock = stubPagedHistory()
  const onSeeked = vi.fn()
  renderStream('job-1', false, 'message-older', onSeeked)
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
  renderStream('job-1', false, 'message-gone')
  expect(
    await screen.findByText('Couldn’t find that message. It may have been deleted or moved.'),
  ).toBeDefined()
})

test('Retry reply posts to the contract endpoint for an agent reply', async () => {
  const fetchMock = stubStream()
  renderStream('job-1')
  await screen.findByText('Read layer is ready.')
  fireEvent.click(boldButton('Retry reply from builder'))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url) === '/api/rooms/room-1/messages/message-1/retry' && init?.method === 'POST',
      ),
    ).toBe(true),
  )
  expect(boldButton('Retry reply from builder').textContent).toContain('Retrying')
})

test('a newly completed agent message is announced once, after history loads', async () => {
  const live = stubLiveStream({ pages: { 'job-1': pages['job-1'] ?? [], 'job-2': [] } })
  renderStream('job-1', false, null, () => undefined, live.stream as unknown as StreamClient)
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
  renderStream('job-1', false, null, () => undefined, live.stream as unknown as StreamClient)
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
  renderStream('job-1', false, null, () => undefined, live.stream as unknown as StreamClient)
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
