import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
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
import { BoldDirect, DirectHeaderActions, PrivacyNote } from './BoldDirect.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const builder = agents[1]!
const directRoom = {
  ...teamRoom,
  id: 'direct-builder',
  name: 'builder',
  kind: 'direct' as const,
  leadAgentId: 'builder',
  members: ['builder'],
  role: 'direct' as const,
  routing: 'mentions' as const,
}
const older = makeJob({
  id: 'chat-old',
  roomId: directRoom.id,
  title: 'The cursor bug',
  lastMessageAt: '2026-10-21T13:14:00.000Z',
  summary: 'Cursor is (created_at, id).',
  createdAt: '2026-10-21T13:12:00.000Z',
})
const newer = makeJob({
  id: 'chat-new',
  roomId: directRoom.id,
  title: 'Websockets or server-sent events',
  lastMessageAt: '2026-10-24T11:14:00.000Z',
  summary: 'Sockets go both ways.',
  createdAt: '2026-10-24T11:12:00.000Z',
})
const teamJob = makeJob({ id: 'team-job', roomId: teamRoom.id, title: 'Release notes 2.4' })

function stub(chats = [newer, older]) {
  const posts: { url: string; body: unknown }[] = []
  const fetchMock = mockFetch((url, init) => {
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
    if (url === '/api/agents/builder/direct')
      return jsonResponse({ asOfSeq: 1, room: chats.length ? directRoom : null, chats })
    if (url === '/api/team-room')
      return jsonResponse({ asOfSeq: 1, room: teamRoom, jobs: [teamJob] })
    if (url.startsWith('/api/rooms/direct-builder/messages'))
      return jsonResponse({
        asOfSeq: 1,
        // Newest first, as the server pages them.
        items: [
          makeMessage({
            id: 'answer',
            roomId: directRoom.id,
            jobId: 'chat-new',
            author: { kind: 'agent', agentId: 'builder' },
            parts: [{ kind: 'text', text: 'Sockets go both ways.' }],
            createdAt: '2026-10-24T11:14:00.000Z',
          }),
          makeMessage({
            id: 'question',
            roomId: directRoom.id,
            jobId: 'chat-new',
            parts: [{ kind: 'text', text: 'Why websockets?' }],
            createdAt: '2026-10-24T11:13:00.000Z',
          }),
        ],
        nextCursor: null,
        jobId: 'chat-new',
      })
    return jsonResponse({ asOfSeq: 0, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return posts
}

function renderDirect(chatId: string | null = 'chat-new') {
  return renderInRoom(
    <BoldDirect
      agent={builder}
      agents={agents}
      chatId={chatId}
      referenceJobId={null}
      onClearReference={() => undefined}
    />,
    [`/b?with=builder${chatId ? `&chat=${chatId}` : ''}`],
  )
}

test('the privacy label is a protected surface that names the agent', () => {
  renderInRoom(<PrivacyNote agentId="builder" />)
  const label = screen.getByText('Only you and builder see this')
  expect(label.closest('[data-protected]')).not.toBeNull()
  expect(label.className).toContain('bold-dm-privacy')
})

test('with no chats the home says it is just you and the agent, and offers starters', async () => {
  stub([])
  renderDirect(null)
  expect(await screen.findByRole('heading', { name: 'Just you and builder' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'What are you working on?' })).toBeTruthy()
})

test('a chat reads oldest first and its latest reply can be shared or brought into a new chat', async () => {
  stub()
  const { container } = renderDirect()
  await screen.findByText('Sockets go both ways.')
  const messages = [...container.querySelectorAll('.bold-dm-message')].map(
    (node) => node.textContent,
  )
  expect(messages[0]).toContain('Why websockets?')
  expect(messages[1]).toContain('Sockets go both ways.')
  expect(screen.getByRole('button', { name: 'Share to the team room' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Bring into a new chat' })).toBeTruthy()
  expect(screen.getByPlaceholderText('Message builder privately')).toBeTruthy()
})

test('an unknown chat id says so and offers the way back', async () => {
  stub()
  renderDirect('gone')
  expect(await screen.findByRole('heading', { name: 'This chat isn’t here any more' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Back to builder' })).toBeTruthy()
})

test('sharing posts the reply to the chosen team job and then says it was shared', async () => {
  const posts = stub()
  renderDirect()
  fireEvent.click(await screen.findByRole('button', { name: 'Share to the team room' }))
  const menu = await screen.findByRole('dialog', { name: 'Share to the team room' })
  expect(menu.getAttribute('data-protected')).toBe('block')
  fireEvent.click(await within(menu).findByRole('button', { name: /Release notes 2\.4/ }))
  await screen.findByText('Shared to the team room')
  expect(posts.find((post) => post.url.endsWith('/share'))).toMatchObject({
    url: '/api/messages/answer/share',
    body: { jobId: 'team-job' },
  })
})

test('Add someone starts a team-room job that references the chat, not a copy of it', async () => {
  const posts = stub()
  renderDirect()
  fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add someone to this one-to-one' })
  expect(dialog.getAttribute('data-protected')).toBe('block')
  expect(within(dialog).queryByRole('button', { name: 'Add builder' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add reviewer' }))
  await waitFor(() =>
    expect(posts.find((post) => post.url === '/api/rooms/room-1/messages')).toBeDefined(),
  )
  expect(posts.find((post) => post.url === '/api/rooms/room-1/messages')?.body).toMatchObject({
    to: ['reviewer'],
    jobId: 'moved',
    refs: [{ jobId: 'chat-new' }],
  })
})

test('earlier chats search by title and summary, and New chat starts one', async () => {
  const posts = stub()
  renderInRoom(<DirectHeaderActions agent={builder} chatId="chat-new" />, ['/b?with=builder'])
  fireEvent.click(screen.getByRole('button', { name: 'Earlier chats' }))
  const dialog = await screen.findByRole('dialog', { name: 'Earlier chats with builder' })
  await within(dialog).findByText('The cursor bug')
  expect(within(dialog).getByText('Websockets or server-sent events')).toBeTruthy()
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search chats' }), {
    target: { value: 'created_at' },
  })
  expect(within(dialog).getByText('The cursor bug')).toBeTruthy()
  expect(within(dialog).queryByText('Websockets or server-sent events')).toBeNull()
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search chats' }), {
    target: { value: 'nothing here' },
  })
  expect(within(dialog).getByText('No chats match “nothing here”.')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'New chat with builder' }))
  await waitFor(() =>
    expect(posts.some((post) => post.url === '/api/agents/builder/chats')).toBe(true),
  )
})
