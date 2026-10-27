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

let questionItems: unknown[] = []

afterEach(() => {
  questionItems = []
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

function stub(chats = [newer, older], extra?: (url: string) => Response | undefined) {
  const posts: { url: string; body: unknown }[] = []
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
    if (url === '/api/questions?status=all')
      return jsonResponse({ asOfSeq: 1, items: questionItems })
    if (url === '/api/agents/builder/direct')
      return jsonResponse({ asOfSeq: 1, room: chats.length ? directRoom : null, chats })
    if (url === '/api/team-room')
      return jsonResponse({ asOfSeq: 1, room: teamRoom, jobs: [teamJob] })
    if (url.startsWith(`/api/rooms/${teamRoom.id}/jobs`))
      return jsonResponse({ asOfSeq: 1, items: [teamJob] })
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
  renderInRoom(<PrivacyNote agent={builder} />)
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

test('Add someone says what leaves, then starts the job and asks both agents', async () => {
  const posts = stub()
  renderDirect()
  fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add someone to this one-to-one' })
  expect(dialog.getAttribute('data-protected')).toBe('block')
  expect(within(dialog).queryByRole('button', { name: 'Add builder' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add reviewer' }))
  // Nothing has left yet: the dialog names the job and the summary first.
  expect(posts).toHaveLength(0)
  expect(within(dialog).getByText('Websockets or server-sent events')).toBeTruthy()
  expect(within(dialog).getByText(/Sockets go both ways\./)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add reviewer and share a summary' }))
  await waitFor(() =>
    expect(posts.find((post) => post.url === '/api/rooms/room-1/messages')).toBeDefined(),
  )
  expect(posts[0]).toMatchObject({
    url: '/api/rooms/room-1/jobs',
    body: { title: 'Websockets or server-sent events' },
  })
  expect(posts.find((post) => post.url === '/api/rooms/room-1/messages')?.body).toMatchObject({
    to: ['builder', 'reviewer'],
    jobId: 'moved',
    refs: [{ jobId: 'chat-new' }],
  })
})

test('when the hand-off message fails the job is kept and only the message is retried', async () => {
  const posts = stub()
  const original = globalThis.fetch
  let fail = true
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/rooms/room-1/messages' && init?.method === 'POST' && fail) {
      posts.push({ url: String(input), body: JSON.parse(String(init.body)) })
      return Promise.resolve(jsonResponse({ code: 'boom', message: 'No.' }, 500))
    }
    return original(input, init)
  })
  renderDirect()
  fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add someone to this one-to-one' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add reviewer' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add reviewer and share a summary' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('didn’t send')
  fail = false
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry the message to reviewer' }))
  await waitFor(() =>
    expect(posts.filter((post) => post.url === '/api/rooms/room-1/jobs')).toHaveLength(1),
  )
})

test('Escape closes the share menu and returns focus to the button that opened it', async () => {
  stub()
  renderDirect()
  const open = await screen.findByRole('button', { name: 'Share to the team room' })
  open.focus()
  fireEvent.click(open)
  await screen.findByRole('dialog', { name: 'Share to the team room' })
  fireEvent.keyDown(document.body, { key: 'Escape' })
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Share to the team room' })).toBeNull(),
  )
  expect(document.activeElement).toBe(open)
})

test('an empty default thread is not listed among the earlier chats', async () => {
  stub([
    newer,
    makeJob({
      id: 'plumbing',
      roomId: directRoom.id,
      title: 'builder',
      isDefault: true,
      messageCount: 0,
    }),
  ])
  renderInRoom(<DirectHeaderActions agent={builder} chatId="chat-new" />, ['/b?with=builder'])
  fireEvent.click(screen.getByRole('button', { name: 'Earlier chats' }))
  const dialog = await screen.findByRole('dialog', { name: 'Earlier chats with builder' })
  await within(dialog).findByText('Websockets or server-sent events')
  expect(dialog.querySelectorAll('.bold-dm-history-row')).toHaveLength(1)
})

test('"Load earlier" fetches the page before the oldest message', async () => {
  stub()
  const base = globalThis.fetch
  const urls: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/rooms/direct-builder/messages')) {
      urls.push(url)
      if (url.includes('before=cursor-1'))
        return Promise.resolve(
          jsonResponse({
            asOfSeq: 1,
            items: [
              makeMessage({
                id: 'ancient',
                roomId: directRoom.id,
                jobId: 'chat-new',
                parts: [{ kind: 'text', text: 'The very first question.' }],
                createdAt: '2026-10-23T09:00:00.000Z',
              }),
            ],
            nextCursor: null,
            jobId: 'chat-new',
          }),
        )
      return Promise.resolve(
        jsonResponse({
          asOfSeq: 1,
          items: [
            makeMessage({
              id: 'recent',
              roomId: directRoom.id,
              jobId: 'chat-new',
              parts: [{ kind: 'text', text: 'A recent line.' }],
              createdAt: '2026-10-24T11:13:00.000Z',
            }),
          ],
          nextCursor: 'cursor-1',
          jobId: 'chat-new',
        }),
      )
    }
    return base(input, init)
  })
  const { container } = renderDirect()
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier' }))
  await screen.findByText('The very first question.')
  const lines = [...container.querySelectorAll('.bold-dm-message')].map((node) => node.textContent)
  expect(lines[0]).toContain('The very first question.')
  expect(lines[1]).toContain('A recent line.')
  expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull()
})

test('earlier chats search by title and summary, and New chat starts one', async () => {
  const posts = stub()
  renderInRoom(<DirectHeaderActions agent={builder} chatId="chat-new" />, ['/b?with=builder'])
  fireEvent.click(screen.getByRole('button', { name: 'Earlier chats' }))
  const dialog = await screen.findByRole('dialog', { name: 'Earlier chats with builder' })
  await within(dialog).findByText('The cursor bug')
  expect(within(dialog).getByPlaceholderText('Search titles and summaries')).toBeTruthy()
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

async function openChatMenu(chatId: string | null) {
  renderInRoom(<DirectHeaderActions agent={builder} chatId={chatId} />, ['/b?with=builder'])
  const menu = await screen.findByRole('button', { name: 'Chat menu' })
  fireEvent.click(menu)
}

const mainChat = makeJob({
  id: 'main-chat',
  roomId: directRoom.id,
  title: 'builder',
  isDefault: true,
  messageCount: 3,
  lastMessageAt: '2026-10-25T09:00:00.000Z',
})

test('Delete chat is offered for a real chat in the URL, never for the new-chat state', async () => {
  stub()
  await openChatMenu('chat-new')
  expect(screen.getByRole('menuitem', { name: 'Delete chat' })).toBeDefined()
  expect(screen.queryByRole('menuitem', { name: 'Clear chat' })).toBeNull()
})

test('the new-chat state (no chat in the URL) offers neither Delete chat nor Clear chat', async () => {
  stub()
  await openChatMenu(null)
  expect(screen.getByRole('menuitemcheckbox', { name: 'Show deleted messages' })).toBeDefined()
  expect(screen.queryByRole('menuitem', { name: 'Delete chat' })).toBeNull()
  expect(screen.queryByRole('menuitem', { name: 'Clear chat' })).toBeNull()
})

test('the main chat (the default thread) is never deleted: it offers Clear chat instead', async () => {
  stub([newer, mainChat])
  await openChatMenu('main-chat')
  expect(screen.queryByRole('menuitem', { name: 'Delete chat' })).toBeNull()
  expect(screen.getByRole('menuitem', { name: 'Clear chat' })).toBeDefined()
})

test('Clear chat confirms, posts to the room, and reports how many messages went', async () => {
  stub([newer, mainChat])
  const base = globalThis.fetch
  const calls: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/rooms/direct-builder/clear') {
      calls.push(`${init?.method} ${String(input)}`)
      return Promise.resolve(jsonResponse({ cleared: 3 }))
    }
    return base(input, init)
  })
  await openChatMenu('main-chat')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Clear chat' }))
  const dialog = await screen.findByRole('dialog', { name: 'Clear this chat with builder?' })
  expect(dialog.getAttribute('data-protected')).toBe('any')
  expect(dialog.textContent).toContain(
    'Removes every message of this chat from Score. builder may still remember them. Other chats with builder stay.',
  )
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clear chat' }))
  expect((await within(dialog).findByRole('status')).textContent).toBe('Cleared 3 messages.')
  expect(calls).toEqual(['POST /api/rooms/direct-builder/clear'])
})

test('Clear chat shows the server’s 409 message verbatim', async () => {
  stub([newer, mainChat])
  const base = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === '/api/rooms/direct-builder/clear'
      ? Promise.resolve(
          jsonResponse(
            { error: { code: 'conflict', message: 'A message is still being written.' } },
            409,
          ),
        )
      : base(input, init),
  )
  await openChatMenu('main-chat')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Clear chat' }))
  const dialog = await screen.findByRole('dialog', { name: 'Clear this chat with builder?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clear chat' }))
  expect((await within(dialog).findByRole('alert')).textContent).toBe(
    'A message is still being written.',
  )
})

test('an open question is a card in the thread and an ended one a muted line where it was asked', async () => {
  const asked = {
    id: 'q-1',
    agentId: 'builder',
    runId: 'run-1',
    roomId: directRoom.id,
    jobId: 'chat-new',
    question: 'Which port?',
    options: ['8080', '9090'],
    multiSelect: false,
    status: 'pending',
    answer: null,
    answeredBy: null,
    delivery: 'none',
    createdAt: '2026-10-24T11:13:30.000Z',
    expiresAt: null,
    answeredAt: null,
  }
  questionItems = [
    asked,
    {
      ...asked,
      id: 'q-0',
      question: 'Keep the cursor?',
      status: 'answered',
      answer: 'Yes',
      answeredBy: 'you',
      delivery: 'applied',
      createdAt: '2026-10-24T11:12:30.000Z',
    },
  ]
  stub()
  renderDirect()
  const card = await screen.findByRole('region', { name: 'builder asks' })
  expect(card.getAttribute('data-protected')).toBe('flex')
  expect(within(card).getByRole('button', { name: '9090' })).toBeTruthy()
  const note = await screen.findByText(/builder asked: Keep the cursor\?/)
  expect(note.textContent).toContain('you answered: Yes')
})

const docsTeam = {
  ...teamRoom,
  id: 'room-docs',
  name: 'Docs team',
  members: ['lead', 'builder'],
  everyone: false,
}
const docsJob = makeJob({ id: 'docs-job', roomId: docsTeam.id, title: 'Docs sweep' })
const twoTeams = (url: string) => {
  if (url === '/api/team-rooms')
    return jsonResponse({ asOfSeq: 1, items: [{ ...teamRoom, everyone: true }, docsTeam] })
  if (url.startsWith(`/api/rooms/${docsTeam.id}/jobs`))
    return jsonResponse({ asOfSeq: 1, items: [docsJob] })
  return undefined
}

test('with one team room the share menu and Add someone show no team choice', async () => {
  stub()
  renderDirect()
  fireEvent.click(await screen.findByRole('button', { name: 'Share to the team room' }))
  const menu = await screen.findByRole('dialog', { name: 'Share to the team room' })
  expect(within(menu).queryByRole('combobox')).toBeNull()
})

test('with two team rooms the share menu says "Share to a team" and lists the chosen team’s jobs', async () => {
  const posts = stub([newer, older], twoTeams)
  renderDirect()
  fireEvent.click(await screen.findByRole('button', { name: 'Share to the team room' }))
  const menu = await screen.findByRole('dialog', { name: 'Share to a team' })
  expect(menu.getAttribute('data-protected')).toBe('block')
  await within(menu).findByRole('button', { name: /Release notes 2\.4/ })
  fireEvent.change(within(menu).getByRole('combobox'), { target: { value: 'room-docs' } })
  fireEvent.click(await within(menu).findByRole('button', { name: /Docs sweep/ }))
  await screen.findByText('Shared to the team room')
  expect(posts.find((post) => post.url.endsWith('/share'))?.body).toEqual({ jobId: 'docs-job' })
})

test('with two team rooms Add someone starts the job in the chosen team and offers only its members', async () => {
  const posts = stub([newer, older], twoTeams)
  renderDirect()
  fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add someone to this one-to-one' })
  fireEvent.change(await within(dialog).findByRole('combobox'), {
    target: { value: 'room-docs' },
  })
  // reviewer is not in the Docs team, lead is.
  expect(within(dialog).queryByRole('button', { name: 'Add reviewer' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add lead' }))
  expect(within(dialog).getByText(/Starts in Docs team/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add lead and share a summary' }))
  await waitFor(() =>
    expect(posts.find((post) => post.url === '/api/rooms/room-docs/messages')).toBeDefined(),
  )
  expect(posts[0]?.url).toBe('/api/rooms/room-docs/jobs')
})

test('with one team room Add someone shows no team choice', async () => {
  stub()
  renderDirect()
  fireEvent.click(await screen.findByRole('button', { name: 'Add someone' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add someone to this one-to-one' })
  expect(within(dialog).queryByRole('combobox')).toBeNull()
})

test('the one-to-one has a shortcut to the agent’s screen while its Hermes serves it (3.12.1)', async () => {
  stub()
  renderInRoom(<DirectHeaderActions agent={builder} chatId={null} />, ['/b?with=builder'])
  const link = await screen.findByRole('link', { name: `Look at ${builder.name}'s screen` })
  expect(link.getAttribute('href')).toBe('/b/screen/builder')
})

test('no screen shortcut for a coding agent (it has no Bot Desktop)', () => {
  stub()
  renderInRoom(<DirectHeaderActions agent={{ ...builder, runtime: 'codex' }} chatId={null} />, [
    '/b?with=builder',
  ])
  expect(screen.queryByRole('link', { name: /screen/ })).toBeNull()
})

test('no screen shortcut for an agent Hermes isn’t serving', () => {
  stub()
  renderInRoom(<DirectHeaderActions agent={{ ...builder, served: false }} chatId={null} />, [
    '/b?with=builder',
  ])
  expect(screen.queryByRole('link', { name: /screen/ })).toBeNull()
})
