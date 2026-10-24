import type { Job, Room } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { jsonResponse, makeJob, makeMessage, mockFetch } from '../room/room-test-utils.tsx'
import {
  createDirectChat,
  directChatsQuery,
  moveChatToTeamRoom,
  shareMessageToJob,
} from './direct-queries.ts'

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

test('Add someone creates a team-room job, then posts one addressed reference to this chat', async () => {
  const fetchMock = mockFetch((url, init) => {
    if (url === '/api/rooms/team-room/jobs') {
      expect(JSON.parse(String(init.body))).toEqual({ title: 'The cursor bug' })
      return jsonResponse(chat('team-chat', 'The cursor bug', null), 201)
    }
    expect(url).toBe('/api/rooms/team-room/messages')
    expect(JSON.parse(String(init.body))).toEqual({
      text: '@lead Let’s continue this chat with the team.',
      to: ['lead'],
      jobId: 'team-chat',
      refs: [{ jobId: 'chat-cursor' }],
    })
    return jsonResponse({
      message: makeMessage({
        id: 'message-1',
        roomId: 'team-room',
        jobId: 'team-chat',
        to: ['lead'],
        parts: [{ kind: 'text', text: 'Let’s continue this chat.' }],
      }),
      routedTo: ['lead'],
      command: null,
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  const made = await moveChatToTeamRoom(
    'team-room',
    chat('chat-cursor', 'The cursor bug', null),
    'lead',
  )
  expect(made.id).toBe('team-chat')
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
