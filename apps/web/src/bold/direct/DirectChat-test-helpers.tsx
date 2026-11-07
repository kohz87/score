import { vi } from 'vitest'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeJob,
  makeMessage,
  mockFetch,
  renderInRoom,
  room as teamRoom,
} from '../room/room-test-utils.tsx'
import { DirectChat } from './DirectChat.tsx'

export function resetDirectChatTest() {
  disposeRoomTest()
  vi.unstubAllGlobals()
}

export const builder = agents[1]!
export const directRoom = {
  ...teamRoom,
  id: 'direct-builder',
  name: 'builder',
  kind: 'direct' as const,
  leadAgentId: 'builder',
  members: ['builder'],
  role: 'direct' as const,
  routing: 'mentions' as const,
}
export const older = makeJob({
  id: 'chat-old',
  roomId: directRoom.id,
  title: 'The cursor bug',
  state: 'done',
  lastMessageAt: '2026-10-21T13:14:00.000Z',
  summary: 'Cursor is (created_at, id).',
  createdAt: '2026-10-21T13:12:00.000Z',
  messageCount: 2,
})
export const newer = makeJob({
  id: 'chat-new',
  roomId: directRoom.id,
  title: 'Websockets or server-sent events',
  lastMessageAt: '2026-10-24T11:14:00.000Z',
  summary: 'Sockets go both ways.',
  createdAt: '2026-10-24T11:12:00.000Z',
  messageCount: 2,
})
export const mainChat = makeJob({
  id: 'main-chat',
  roomId: directRoom.id,
  title: 'builder',
  isDefault: true,
  messageCount: 3,
  lastMessageAt: '2026-10-25T09:00:00.000Z',
  createdAt: '2026-10-01T09:00:00.000Z',
})
const teamJob = makeJob({ id: 'team-job', roomId: teamRoom.id, title: 'Release notes 2.4' })

export const text = (value: string) => [{ kind: 'text' as const, text: value }]
export const thread = [
  // Newest first, as the server pages them.
  makeMessage({
    id: 'answer',
    roomId: directRoom.id,
    jobId: 'chat-new',
    author: { kind: 'agent', agentId: 'builder' },
    parts: text('Sockets go both ways.'),
    createdAt: '2026-10-24T11:14:00.000Z',
  }),
  makeMessage({
    id: 'question',
    roomId: directRoom.id,
    jobId: 'chat-new',
    parts: text('Why websockets?'),
    createdAt: '2026-10-24T11:13:00.000Z',
  }),
  makeMessage({
    id: 'old-answer',
    roomId: directRoom.id,
    jobId: 'chat-old',
    author: { kind: 'agent', agentId: 'builder' },
    parts: text('Cursor is (created_at, id).'),
    createdAt: '2026-10-21T13:14:00.000Z',
  }),
  makeMessage({
    id: 'old-question',
    roomId: directRoom.id,
    jobId: 'chat-old',
    parts: text('What is the cursor?'),
    createdAt: '2026-10-21T13:13:00.000Z',
  }),
]

type Post = { url: string; body: unknown }

export function stub(
  chats = [newer, older],
  extra?: (url: string) => Response | undefined,
  room: typeof directRoom | null = directRoom,
  questions: () => unknown[] = () => [],
) {
  const posts: Post[] = []
  const fetchMock = mockFetch((url, init) => {
    if (init.method !== 'POST') {
      const made = extra?.(url)
      if (made) return made
    }
    if (init.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
      if (url.endsWith('/chats'))
        return jsonResponse(
          makeJob({ id: 'chat-made', roomId: directRoom.id, title: 'New chat' }),
          201,
        )
      if (url.endsWith('/share')) return jsonResponse({ messageId: 'copy' }, 201)
      if (url.endsWith('/jobs'))
        return jsonResponse(makeJob({ id: 'moved', roomId: teamRoom.id }), 201)
      return jsonResponse({ message: makeMessage({ id: 'posted' }) }, 201)
    }
    if (url === '/api/questions?status=all') return jsonResponse({ asOfSeq: 1, items: questions() })
    if (url === '/api/agents/builder/direct')
      return jsonResponse({ asOfSeq: 1, room, chats: room ? chats : [] })
    if (url === '/api/team-room')
      return jsonResponse({ asOfSeq: 1, room: teamRoom, jobs: [teamJob] })
    if (url.startsWith(`/api/rooms/${teamRoom.id}/jobs`))
      return jsonResponse({ asOfSeq: 1, items: [teamJob] })
    if (url.startsWith('/api/rooms/direct-builder/messages'))
      return jsonResponse({ asOfSeq: 1, items: thread, nextCursor: null, jobId: 'main-chat' })
    return jsonResponse({ asOfSeq: 0, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return posts
}

export function renderDirect(
  search = '?with=builder&chat=chat-new',
  over: Partial<Parameters<typeof DirectChat>[0]> = {},
) {
  const props = {
    onToggleInfo: vi.fn(),
    onChatInfo: vi.fn(),
    onBackToChats: vi.fn(),
    ...over,
  }
  const view = renderInRoom(
    <DirectChat agent={builder} agents={agents} phone={false} infoOpen={false} {...props} />,
    [`/b${search}`],
  )
  return { ...view, ...props }
}
