import type { Message, RoomVersion, StreamEvent } from '@score/contract'
import { screen } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import type { StreamClient } from '../../data/stream.ts'
import {
  disposeRoomTest,
  jsonResponse,
  makeJob,
  makeMessage,
  mockFetch,
  renderInRoom,
} from './room-test-utils.tsx'
import { RoomMessageStream } from './RoomMessageStream.tsx'

export function setupRoomMessageStreamTest() {
  afterEach(() => {
    disposeRoomTest()
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })
}

export const jobs = [
  makeJob({ id: 'job-1', title: 'Activity feed', state: 'working' }),
  makeJob({ id: 'job-2', title: 'Release notes', state: 'working' }),
]
export const pages: Record<string, Message[]> = {
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

export function stubStream(
  options: {
    pages?: Record<string, Message[]>
    versions?: RoomVersion[]
  } = {},
) {
  const byJob = options.pages ?? pages
  const fetchMock = mockFetch((url, init) => {
    const parsed = new URL(url, 'http://x')
    if (parsed.pathname === '/api/rooms/room-1/messages') {
      // The chat reads every topic in one chain (`all=1`); a per-topic read is still answered for the other callers.
      const jobId = parsed.searchParams.get('jobId') ?? ''
      const all = parsed.searchParams.get('all') === '1'
      return jsonResponse({
        asOfSeq: 1,
        items: all ? Object.values(byJob).flat() : (byJob[jobId] ?? []),
        nextCursor: null,
        jobId: all ? null : jobId,
      })
    }
    if (parsed.pathname === '/api/approvals')
      return jsonResponse({ asOfSeq: 1, items: [], nextCursor: null })
    if (parsed.pathname === '/api/tasks')
      return jsonResponse({
        asOfSeq: 1,
        columns: { planned: [], working: [], in_review: [], needs_you: [], done: [] },
      })
    if (parsed.pathname === '/api/orchestrations/fence')
      return jsonResponse({
        fenced: false,
        reason: null,
        untrustedHistory: false,
        revision: 1,
        since: null,
        items: [],
        journal: { ok: true, entries: 0, bytes: 0, sizeAlarm: false },
      })
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

export function stubLiveStream(options: { pages?: Record<string, Message[]> } = {}) {
  const byJob = options.pages ?? pages
  const listeners = new Set<(event: StreamEvent) => void>()
  const fetchMock = mockFetch((url) => {
    const parsed = new URL(url, 'http://x')
    if (parsed.pathname === '/api/rooms/room-1/messages') {
      // The chat reads every topic in one chain (`all=1`); a per-topic read is still answered for the other callers.
      const jobId = parsed.searchParams.get('jobId') ?? ''
      const all = parsed.searchParams.get('all') === '1'
      return jsonResponse({
        asOfSeq: 1,
        items: all ? Object.values(byJob).flat() : (byJob[jobId] ?? []),
        nextCursor: null,
        jobId: all ? null : jobId,
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

export function renderStream(
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
      showDeleted={showDeleted}
      seek={seek}
      onSeeked={onSeeked}
    />,
    ['/b?room=room-1'],
    stream,
  )
}

export function boldButton(name: RegExp | string) {
  const button = screen
    .getAllByRole('button', { name })
    .find((element) => element.classList.contains('bold-act'))
  if (!button) throw new Error(`No bold action button named ${String(name)}`)
  return button
}
