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
import { DirectChat } from './DirectChat.tsx'
import { PrivacyNote } from './direct-parts.tsx'

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
  state: 'done',
  lastMessageAt: '2026-10-21T13:14:00.000Z',
  summary: 'Cursor is (created_at, id).',
  createdAt: '2026-10-21T13:12:00.000Z',
  messageCount: 2,
})
const newer = makeJob({
  id: 'chat-new',
  roomId: directRoom.id,
  title: 'Websockets or server-sent events',
  lastMessageAt: '2026-10-24T11:14:00.000Z',
  summary: 'Sockets go both ways.',
  createdAt: '2026-10-24T11:12:00.000Z',
  messageCount: 2,
})
const mainChat = makeJob({
  id: 'main-chat',
  roomId: directRoom.id,
  title: 'builder',
  isDefault: true,
  messageCount: 3,
  lastMessageAt: '2026-10-25T09:00:00.000Z',
  createdAt: '2026-10-01T09:00:00.000Z',
})
const teamJob = makeJob({ id: 'team-job', roomId: teamRoom.id, title: 'Release notes 2.4' })

const text = (value: string) => [{ kind: 'text' as const, text: value }]
const thread = [
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

function stub(
  chats = [newer, older],
  extra?: (url: string) => Response | undefined,
  room: typeof directRoom | null = directRoom,
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
    if (url === '/api/questions?status=all')
      return jsonResponse({ asOfSeq: 1, items: questionItems })
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

function renderDirect(
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

test('the privacy label is a protected surface that names the agent', () => {
  renderInRoom(<PrivacyNote agent={builder} />)
  const label = screen.getByText('Only you and builder see this')
  expect(label.closest('[data-protected]')).not.toBeNull()
  expect(label.className).toContain('bold-dm-privacy')
})

test('the header shows the agent, "Direct · status", the privacy label and Chat info', async () => {
  stub()
  const { onToggleInfo } = renderDirect()
  await screen.findByText('Sockets go both ways.')
  const heading = await screen.findByRole('heading', { name: 'builder' })
  const bar = heading.closest('.bold-chat-bar')!
  expect(bar.textContent).toContain('Direct · working')
  expect(within(bar as HTMLElement).getByText('Only you and builder see this')).toBeTruthy()
  fireEvent.click(within(bar as HTMLElement).getByRole('button', { name: 'Chat info' }))
  expect(onToggleInfo).toHaveBeenCalled()
})

test('on a phone the chat bar has the same Back and Info as a group chat, and the open chat in its line', async () => {
  stub()
  const { onBackToChats, onChatInfo } = renderDirect('?with=builder&chat=chat-new', {
    phone: true,
  })
  await screen.findByText('Sockets go both ways.')
  const title = await screen.findByText('builder', { selector: '[data-phone-chat-title]' })
  const bar = title.closest('.bold-chat-phone-bar') as HTMLElement
  expect(bar.textContent).toContain('Websockets or server-sent events · Direct · working')
  expect(within(bar).getByText('Only you and builder see this')).toBeTruthy()
  fireEvent.click(within(bar).getByRole('button', { name: 'Back to chats' }))
  expect(onBackToChats).toHaveBeenCalled()
  fireEvent.click(within(bar).getByRole('button', { name: 'Chat info' }))
  expect(onChatInfo).toHaveBeenCalled()
})

test('with no chat room yet the home says it is just you and the agent, and a starter makes the first chat', async () => {
  const posts = stub([], undefined, null)
  renderDirect('?with=builder')
  expect(await screen.findByRole('heading', { name: 'Just you and builder' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'What are you working on?' }))
  await waitFor(() =>
    expect(posts.some((post) => post.url === '/api/agents/builder/chats')).toBe(true),
  )
})

test('the agent’s earlier chats are topics of one conversation, oldest first, each opened by a divider', async () => {
  stub()
  const { container } = renderDirect()
  await screen.findByText('Sockets go both ways.')
  const order = [...container.querySelectorAll('.bold-topic-divider, .bold-message')].map((node) =>
    node.classList.contains('bold-topic-divider')
      ? `divider:${node.getAttribute('data-topic-id')}`
      : node.getAttribute('data-message-id'),
  )
  expect(order).toEqual([
    'divider:chat-old',
    'old-question',
    'old-answer',
    'divider:chat-new',
    'question',
    'answer',
  ])
  const divider = container.querySelector('[data-topic-id="chat-old"]')!
  expect(divider.textContent).toContain('Topic · The cursor bug · done')
  expect(screen.getByPlaceholderText('Message builder privately')).toBeTruthy()
})

test('the composer writes to the newest open chat and says so under the box', async () => {
  const posts = stub()
  renderDirect('?with=builder')
  await screen.findByText('Sockets go both ways.')
  const bar = await screen.findByLabelText('Where this message goes')
  expect(bar.textContent).toContain('To builder')
  expect(bar.textContent).toContain('in Websockets or server-sent events')
  fireEvent.change(screen.getByPlaceholderText('Message builder privately'), {
    target: { value: 'And long polling?' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(posts.find((post) => post.url === '/api/rooms/direct-builder/messages')).toBeDefined(),
  )
  expect(
    posts.find((post) => post.url === '/api/rooms/direct-builder/messages')?.body,
  ).toMatchObject({ jobId: 'chat-new', text: 'And long polling?' })
})

test('a chat picked in the address (an old chat link) becomes the current one', async () => {
  const posts = stub()
  renderDirect('?with=builder&chat=chat-old')
  await screen.findByText('Sockets go both ways.')
  const bar = await screen.findByLabelText('Where this message goes')
  expect(bar.textContent).toContain('in The cursor bug')
  fireEvent.change(screen.getByPlaceholderText('Message builder privately'), {
    target: { value: 'One more thing' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(posts.find((post) => post.url === '/api/rooms/direct-builder/messages')).toBeDefined(),
  )
  expect(
    posts.find((post) => post.url === '/api/rooms/direct-builder/messages')?.body,
  ).toMatchObject({ jobId: 'chat-old' })
})

test('the / palette offers the chat commands that fit a one-to-one, and /new starts a new chat', async () => {
  const posts = stub()
  renderDirect()
  await screen.findByText('Sockets go both ways.')
  const box = screen.getByPlaceholderText('Message builder privately')
  fireEvent.change(box, { target: { value: '/' } })
  const list = await screen.findByRole('listbox', { name: 'Commands' })
  const names = within(list)
    .getAllByRole('option')
    .map((option) => option.textContent ?? '')
  expect(names.some((name) => name.startsWith('/new'))).toBe(true)
  expect(names.some((name) => name.startsWith('/rename'))).toBe(true)
  expect(names.some((name) => name.startsWith('/done'))).toBe(true)
  expect(names.some((name) => name.startsWith('/reopen'))).toBe(true)
  // Nothing about owners, members or a room workspace in a one-to-one.
  for (const gone of ['/lead', '/add', '/remove', '/workspace'])
    expect(names.some((name) => name.startsWith(gone))).toBe(false)
  fireEvent.change(box, { target: { value: '/new Long polling' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(posts.find((post) => post.url === '/api/agents/builder/chats')).toBeDefined(),
  )
  expect(posts.find((post) => post.url === '/api/agents/builder/chats')?.body).toEqual({
    title: 'Long polling',
  })
  expect((await screen.findByText(/You started the chat/)).textContent).toContain('New chat')
})

test('a chat’s latest reply can be shared or brought into a new chat', async () => {
  stub()
  renderDirect()
  await screen.findByText('Sockets go both ways.')
  // Share is offered on a reply; Bring into a new chat only on the latest one.
  expect(screen.getAllByRole('button', { name: /^Share message from builder/ })).toHaveLength(2)
  expect(screen.getAllByRole('button', { name: 'Bring into a new chat' })).toHaveLength(1)
})

test('Bring into a new chat opens an empty chat that refers to the one it came from', async () => {
  stub()
  const { container } = renderDirect()
  fireEvent.click(await screen.findByRole('button', { name: 'Bring into a new chat' }))
  expect(await screen.findByRole('heading', { name: 'New chat with builder' })).toBeTruthy()
  expect(container.querySelector('.bold-dm-ref')?.textContent).toContain(
    'Referring to Websockets or server-sent events',
  )
})

test('"Take it aside": the first message makes the chat, carrying the reference', async () => {
  const posts = stub()
  renderDirect('?with=builder&ref=team-job')
  expect(await screen.findByRole('heading', { name: 'New chat with builder' })).toBeTruthy()
  expect(document.querySelector('.bold-dm-ref')?.textContent).toContain(
    'Referring to Release notes 2.4',
  )
  fireEvent.change(screen.getByPlaceholderText('Message builder privately'), {
    target: { value: 'Can you take this?' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(posts.find((post) => post.url === '/api/rooms/direct-builder/messages')).toBeDefined(),
  )
  expect(posts[0]).toMatchObject({
    url: '/api/agents/builder/chats',
    body: { title: 'Release notes 2.4' },
  })
  expect(
    posts.find((post) => post.url === '/api/rooms/direct-builder/messages')?.body,
  ).toMatchObject({ jobId: 'chat-made', refs: [{ jobId: 'team-job' }] })
})

test('the reference chip can be removed', async () => {
  stub()
  renderDirect('?with=builder&chat=chat-new&ref=team-job')
  await screen.findByText(/Referring to/)
  fireEvent.click(screen.getByRole('button', { name: 'Remove reference' }))
  await waitFor(() => expect(screen.queryByText(/Referring to/)).toBeNull())
})

test('an unknown chat id keeps the conversation and says so', async () => {
  stub()
  renderDirect('?with=builder&chat=gone')
  expect((await screen.findByText('That chat isn’t here any more.')).getAttribute('role')).toBe(
    'status',
  )
  await screen.findByText('Sockets go both ways.')
})

test('sharing posts the reply to the chosen team job and then says it was shared', async () => {
  const posts = stub()
  renderDirect()
  fireEvent.click(
    (await screen.findAllByRole('button', { name: /^Share message from builder/ })).at(-1)!,
  )
  const menu = await screen.findByRole('dialog', { name: 'Share to the team room' })
  expect(menu.getAttribute('data-protected')).toBe('block')
  fireEvent.click(await within(menu).findByRole('button', { name: /Release notes 2\.4/ }))
  await screen.findByText('Shared to the team room')
  expect(posts.find((post) => post.url.endsWith('/share'))).toMatchObject({
    url: '/api/messages/answer/share',
    body: { jobId: 'team-job' },
  })
})

test('Escape closes the share menu and returns focus to the button that opened it', async () => {
  stub()
  renderDirect()
  const open = (await screen.findAllByRole('button', { name: /^Share message from builder/ })).at(
    -1,
  )!
  open.focus()
  fireEvent.click(open)
  await screen.findByRole('dialog', { name: 'Share to the team room' })
  fireEvent.keyDown(document.body, { key: 'Escape' })
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Share to the team room' })).toBeNull(),
  )
  expect(document.activeElement).toBe(open)
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

test('with one team room the share menu shows no team choice', async () => {
  stub()
  renderDirect()
  fireEvent.click((await screen.findAllByRole('button', { name: /^Share message from/ })).at(-1)!)
  const menu = await screen.findByRole('dialog', { name: 'Share to the team room' })
  expect(within(menu).queryByRole('combobox')).toBeNull()
})

test('with two team rooms the share menu says "Share to a team" and lists the chosen team’s jobs', async () => {
  const posts = stub([newer, older], twoTeams)
  renderDirect()
  fireEvent.click((await screen.findAllByRole('button', { name: /^Share message from/ })).at(-1)!)
  const menu = await screen.findByRole('dialog', { name: 'Share to a team' })
  await within(menu).findByRole('button', { name: /Release notes 2\.4/ })
  fireEvent.change(within(menu).getByRole('combobox'), { target: { value: 'room-docs' } })
  fireEvent.click(await within(menu).findByRole('button', { name: /Docs sweep/ }))
  await screen.findByText('Shared to the team room')
  expect(posts.find((post) => post.url.endsWith('/share'))?.body).toEqual({ jobId: 'docs-job' })
})

test('rewind, retry, pin and delete stay on a reply’s action row', async () => {
  stub()
  renderDirect()
  await screen.findByText('Sockets go both ways.')
  const actions = screen.getAllByRole('group', { name: 'Actions for message from builder' }).at(-1)!
  expect(within(actions).getByRole('button', { name: /^Try another reply/ })).toBeTruthy()
  expect(within(actions).getByRole('button', { name: /^Pin message/ })).toBeTruthy()
  expect(within(actions).getByRole('button', { name: /^Delete message/ })).toBeTruthy()
  expect(within(actions).getByRole('button', { name: /^Copy message/ })).toBeTruthy()
})

test('the agent’s typing is shown in the conversation', async () => {
  const base = stub()
  void base
  vi.stubGlobal(
    'fetch',
    mockFetch((url) => {
      if (url === '/api/agents/builder/direct')
        return jsonResponse({ asOfSeq: 1, room: directRoom, chats: [newer, older] })
      if (url.startsWith('/api/rooms/direct-builder/messages'))
        return jsonResponse({ asOfSeq: 1, items: thread, nextCursor: null, jobId: 'main-chat' })
      if (url === '/api/questions?status=all') return jsonResponse({ asOfSeq: 1, items: [] })
      return jsonResponse({ asOfSeq: 0, items: [] })
    }),
  )
  const { emit } = renderDirect()
  await screen.findByText('Sockets go both ways.')
  emit({
    seq: 2,
    type: 'typing',
    data: { roomId: directRoom.id, agentId: 'builder', text: 'is thinking' },
  } as never)
  await screen.findByText(/is thinking/)
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
                jobId: 'chat-old',
                parts: text('The very first question.'),
                createdAt: '2026-10-20T09:00:00.000Z',
              }),
            ],
            nextCursor: null,
            jobId: 'main-chat',
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
              parts: text('A recent line.'),
              createdAt: '2026-10-24T11:13:00.000Z',
            }),
          ],
          nextCursor: 'cursor-1',
          jobId: 'main-chat',
        }),
      )
    }
    return base(input, init)
  })
  const { container } = renderDirect()
  fireEvent.click(await screen.findByRole('button', { name: 'Load earlier' }))
  await screen.findByText('The very first question.')
  const lines = [...container.querySelectorAll('.bold-message')].map((node) => node.textContent)
  expect(lines[0]).toContain('The very first question.')
  expect(lines[1]).toContain('A recent line.')
  expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull()
  expect(urls.some((url) => url.includes('all=1'))).toBe(true)
})

async function openChatMenu(search: string, chats = [newer, older]) {
  stub(chats)
  renderDirect(search)
  await screen.findByText('Sockets go both ways.')
  fireEvent.click(await screen.findByRole('button', { name: 'Chat menu' }))
}

test('Delete chat is offered for the current chat, and the room’s own thread offers Clear chat instead', async () => {
  await openChatMenu('?with=builder&chat=chat-new')
  expect(screen.getByRole('menuitem', { name: 'Delete chat' })).toBeDefined()
  expect(screen.queryByRole('menuitem', { name: 'Clear chat' })).toBeNull()
})

test('the main chat (the default thread) is never deleted: it offers Clear chat instead', async () => {
  await openChatMenu('?with=builder&chat=main-chat', [newer, mainChat])
  expect(screen.queryByRole('menuitem', { name: 'Delete chat' })).toBeNull()
  expect(screen.getByRole('menuitem', { name: 'Clear chat' })).toBeDefined()
})

test('the chat menu holds Show deleted messages (it no longer sits above the conversation)', async () => {
  await openChatMenu('?with=builder&chat=chat-new')
  expect(screen.getByRole('menuitemcheckbox', { name: 'Show deleted messages' })).toBeDefined()
})

test('Delete chat confirms, deletes the job and says it can be undone', async () => {
  const base = vi.fn()
  await openChatMenu('?with=builder&chat=chat-new')
  const original = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/jobs/chat-new' && init?.method === 'DELETE') {
      base(String(input))
      return Promise.resolve(jsonResponse({}, 204))
    }
    return original(input, init)
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete chat' }))
  const dialog = await screen.findByRole('dialog', { name: 'Delete this chat with builder?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete chat' }))
  await waitFor(() => expect(base).toHaveBeenCalledWith('/api/jobs/chat-new'))
})

test('Clear chat confirms, posts to the room, and reports how many messages went', async () => {
  await openChatMenu('?with=builder&chat=main-chat', [newer, mainChat])
  const base = globalThis.fetch
  const calls: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/rooms/direct-builder/clear') {
      calls.push(`${init?.method} ${String(input)}`)
      return Promise.resolve(jsonResponse({ cleared: 3 }))
    }
    return base(input, init)
  })
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
  await openChatMenu('?with=builder&chat=main-chat', [newer, mainChat])
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
  fireEvent.click(screen.getByRole('menuitem', { name: 'Clear chat' }))
  const dialog = await screen.findByRole('dialog', { name: 'Clear this chat with builder?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clear chat' }))
  expect((await within(dialog).findByRole('alert')).textContent).toBe(
    'A message is still being written.',
  )
})

test('an open question is a card above the conversation and an ended one a muted line where it was asked', async () => {
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

test('the screen shortcut shows while Hermes serves the agent (3.12.1)', async () => {
  stub()
  renderDirect()
  const link = await screen.findByRole('link', { name: `Look at ${builder.name}'s screen` })
  expect(link.getAttribute('href')).toBe('/b/screen/builder')
})

test('no screen shortcut for a coding agent or an agent Hermes isn’t serving', async () => {
  stub()
  const view = renderDirect()
  await screen.findByRole('heading', { name: 'builder' })
  view.unmount()
  renderInRoom(
    <DirectChat
      agent={{ ...builder, runtime: 'codex' }}
      agents={agents}
      phone={false}
      infoOpen={false}
      onToggleInfo={() => undefined}
      onChatInfo={() => undefined}
      onBackToChats={() => undefined}
    />,
    ['/b?with=builder'],
  )
  await screen.findByRole('heading', { name: 'builder' })
  expect(screen.queryByRole('link', { name: /screen/ })).toBeNull()
})
