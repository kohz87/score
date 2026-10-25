import type { Job, Room } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { jsonResponse, makeJob, mockFetch } from '../room/room-test-utils.tsx'
import { createDirectChat, directChatsQuery, shareMessageToJob } from './direct-queries.ts'

afterEach(() => vi.unstubAllGlobals())

const directRoom: Room = {
  id: 'direct-builder',
  name: 'builder',
  kind: 'direct',
  leadAgentId: 'builder',
  members: ['builder'],
  unread: 0,
  activeAgents: [],
  channels: [],
  role: 'direct',
  routing: 'mentions',
}

const chat = (id: string, title: string, lastMessageAt: string | null): Job =>
  makeJob({ id, roomId: directRoom.id, title, lastMessageAt, summary: `${title} summary` })

test('the direct query keeps only this agent’s room and sorts chats by newest activity', () => {
  const definition = directChatsQuery('builder')
  const older = chat('chat-old', 'Old', '2026-10-20T10:00:00.000Z')
  const newer = chat('chat-new', 'New', '2026-10-24T10:00:00.000Z')
  const initial = { room: directRoom, chats: [older, newer] }

  const afterAnotherRoom = definition.reduce(initial, {
    seq: 2,
    ts: '2026-10-24T10:01:00.000Z',
    type: 'job.upserted',
    data: makeJob({ id: 'team-job', roomId: 'team-room', title: 'Team work' }),
  })
  expect(afterAnotherRoom).toBe(initial)

  const middle = chat('chat-middle', 'Middle', '2026-10-24T09:00:00.000Z')
  const afterNew = definition.reduce(initial, {
    seq: 3,
    ts: '2026-10-24T10:01:00.000Z',
    type: 'job.upserted',
    data: middle,
  })
  expect(afterNew.chats.map((item) => item.id)).toEqual(['chat-new', 'chat-middle', 'chat-old'])
})

test('New chat posts an idempotent chat create and validates the created job', async () => {
  const made = chat('chat-made', 'New chat', null)
  const fetchMock = mockFetch((url, init) => {
    expect(url).toBe('/api/agents/builder/chats')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy()
    expect(init.body).toBe('{}')
    return jsonResponse(made, 201)
  })
  vi.stubGlobal('fetch', fetchMock)
  expect(await createDirectChat('builder')).toMatchObject({ id: 'chat-made', title: 'New chat' })
})

test('a deleted direct chat leaves the history at once', () => {
  const definition = directChatsQuery('builder')
  const older = chat('chat-old', 'Old', '2026-10-20T10:00:00.000Z')
  const newer = chat('chat-new', 'New', '2026-10-24T10:00:00.000Z')
  const next = definition.reduce(
    { room: directRoom, chats: [older, newer] },
    {
      seq: 4,
      ts: '2026-10-24T10:02:00.000Z',
      type: 'job.deleted',
      data: { id: 'chat-new', roomId: directRoom.id },
    },
  )
  expect(next.chats.map((item) => item.id)).toEqual(['chat-old'])
})

test('Share sends the chosen team-room job and starts no turn of its own', async () => {
  const fetchMock = mockFetch((url, init) => {
    expect(url).toBe('/api/messages/message-1/share')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ jobId: 'job-activity' })
    return jsonResponse({ messageId: 'message-shared' }, 201)
  })
  vi.stubGlobal('fetch', fetchMock)
  await shareMessageToJob('message-1', 'job-activity')
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
