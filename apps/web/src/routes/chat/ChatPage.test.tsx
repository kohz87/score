import { StrictMode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  MessageSchema,
  type AgentSummary,
  type Message,
  type Room,
  type StreamEvent,
} from '@score/contract'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { messagesQuery, reduceMessages } from './queries.ts'

const agent: AgentSummary = {
  id: 'lead',
  name: 'Lead',
  role: 'Lead',
  style: { color: '#6B4EFF', shape: 'circle-dot' },
  status: 'working',
  activity: null,
  model: null,
  served: true,
}
const room: Room = {
  id: 'general',
  name: 'general',
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead'],
  unread: 2,
  activeAgents: ['lead'],
  channels: [],
}
const direct: Room = { ...room, id: 'direct-lead', name: 'Lead', kind: 'direct', unread: 1 }
const message: Message = {
  id: 'message-one',
  roomId: 'general',
  author: { kind: 'agent', agentId: 'lead' },
  to: [],
  parts: [{ kind: 'text', text: 'Hello team' }],
  createdAt: '2026-10-08T10:00:00.000Z',
  streaming: true,
  refs: [],
}
class Source extends EventTarget {
  static current: Source
  constructor() {
    super()
    Source.current = this
  }
  close() {}
  emit(event: StreamEvent) {
    this.dispatchEvent(
      new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: String(event.seq) }),
    )
  }
}
const disposers: (() => void)[] = []
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let items: Message[]
let rooms: Room[]
let filesInPlay: string[]
let learned: { text: string; savedTo: string[]; at: string }[]
function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status })
}
function setup(path = '/chat/general') {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  disposers.push(() => {
    router.dispose()
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <StreamContext value={{ client, queries }}>
          <App router={router} />
        </StreamContext>
      </QueryClientProvider>
    </StrictMode>,
  )
  return { router, queryClient, queries }
}
function emit(type: StreamEvent['type'], data: unknown, seq: number) {
  act(() => Source.current.emit({ type, data, seq, ts: '2026-10-08T10:00:00.000Z' } as StreamEvent))
}
beforeEach(() => {
  items = [message]
  rooms = [room]
  filesInPlay = []
  learned = []
  fetchMock = vi.fn(async (input) => {
    const url = String(input)
    if (url === '/api/agents') return response({ asOfSeq: 1, items: [agent] })
    if (url === '/api/rooms') return response({ asOfSeq: 1, rooms, directs: [direct] })
    if (url.includes('/messages'))
      return response({
        asOfSeq: 1,
        items: items.map((item) => ({
          ...item,
          roomId: url.includes('direct-lead') ? 'direct-lead' : item.roomId,
        })),
        nextCursor: null,
      })
    return response({
      asOfSeq: 1,
      room: url.includes('direct-lead') ? direct : room,
      filesInPlay,
      learned,
    })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('shows loading states while snapshots are pending', () => {
  fetchMock.mockImplementation(() => new Promise(() => {}))
  setup()
  expect(screen.getByText('Loading conversations…')).toBeDefined()
  expect(screen.getByText('Loading room…')).toBeDefined()
})
test('index invites room selection and handles an empty rooms list', async () => {
  rooms = []
  setup('/chat')
  expect(screen.getByRole('heading', { level: 1, name: 'Chat' })).toBeDefined()
  await screen.findByText('No rooms yet.')
  expect(screen.getByText('Choose a conversation to see its messages.')).toBeDefined()
})
test('shows an empty thread and an empty composer with Send disabled', async () => {
  items = []
  setup()
  await screen.findByText('No messages yet.')
  expect(screen.getByRole('combobox', { name: 'Message general' }).hasAttribute('disabled')).toBe(
    false,
  )
  expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)
})
test('populated room uses API agents, badges, landmarks and chronological messages', async () => {
  items = [
    message,
    {
      ...message,
      id: 'older',
      author: { kind: 'you' },
      streaming: false,
      createdAt: '2026-10-08T09:00:00.000Z',
      parts: [{ kind: 'text', text: 'Start here' }],
    },
  ]
  setup()
  await screen.findByText('Hello team')
  expect(screen.getByRole('heading', { name: '#general' })).toBeDefined()
  expect(screen.getByText('Unaddressed messages go to Lead')).toBeDefined()
  const nav = within(screen.getByRole('navigation', { name: 'Conversations' }))
  expect(nav.getByRole('link', { name: /#general/ }).getAttribute('aria-current')).toBe('page')
  expect(nav.getByLabelText('2 unread messages')).toBeDefined()
  expect(nav.getByRole('img', { name: 'Lead, circle-dot' })).toBeDefined()
  expect(screen.getAllByRole('article').map((item) => item.getAttribute('aria-label'))).toEqual([
    'Message from You',
    'Message from Lead',
  ])
  expect(screen.getByRole('region', { name: 'Message history' }).tabIndex).toBe(0)
})
test('rooms failure can be retried and invalid responses fail validation', async () => {
  fetchMock.mockImplementation(async () => response({ rooms: 'invalid' }))
  setup('/chat')
  await screen.findByText('Could not load conversations.')
  fetchMock.mockImplementation(async (input) =>
    String(input) === '/api/rooms'
      ? response({ asOfSeq: 1, rooms: [room], directs: [] })
      : response({ asOfSeq: 1, items: [agent] }),
  )
  fireEvent.click(
    within(screen.getByText('Could not load conversations.').parentElement!).getByRole('button', {
      name: 'Try again',
    }),
  )
  await screen.findByRole('link', { name: /#general/ })
})
test('room not found has an error state', async () => {
  fetchMock.mockImplementation(async () =>
    response({ error: { code: 'not_found', message: 'Missing' } }, 404),
  )
  setup('/chat/missing')
  await screen.findByText('Room not found.')
})
test('message failures show an error and retry successfully', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (...args) =>
    String(args[0]).includes('/messages')
      ? response({ error: { code: 'unavailable', message: 'Offline' } }, 503)
      : original(...args),
  )
  setup()
  await screen.findByText('Could not load messages.')
  fetchMock.mockImplementation(original)
  fireEvent.click(
    within(screen.getByText('Could not load messages.').parentElement!).getByRole('button'),
  )
  await screen.findByText('Hello team')
})
test('stream appends once, completes messages and clears typing and unread via room updates', async () => {
  const { queryClient } = setup()
  await screen.findByText('Hello team')
  emit('message.delta', { roomId: 'general', messageId: message.id, append: '!' }, 2)
  emit('message.delta', { roomId: 'general', messageId: message.id, append: '!' }, 2)
  expect(screen.getByText('Hello team!')).toBeDefined()
  expect(queryClient.getQueryData(messagesQuery('general').key)).toMatchObject({
    asOfSeq: 2,
    data: { items: [{ parts: [{ text: 'Hello team!' }] }] },
  })
  emit('typing', { roomId: 'general', agentId: 'lead', text: 'is reviewing' }, 3)
  expect(screen.getByText('Lead is reviewing')).toBeDefined()
  emit('typing', { roomId: 'general', agentId: 'lead', text: null }, 4)
  expect(screen.queryByText('Lead is reviewing')).toBeNull()
  emit('message.completed', { roomId: 'general', messageId: message.id }, 5)
  expect(screen.queryByText('Writing…')).toBeNull()
  emit('room.upserted', { ...room, unread: 0 }, 6)
  expect(screen.queryByLabelText('2 unread messages')).toBeNull()
  emit(
    'message.created',
    { ...message, id: 'new', parts: [{ kind: 'text', text: 'New reply' }], streaming: false },
    7,
  )
  expect(screen.getByText('New reply')).toBeDefined()
})
test('live room and agent updates refresh navigation and names', async () => {
  setup()
  await screen.findByText('Hello team')
  emit('room.upserted', { ...room, id: 'research', name: 'research' }, 2)
  expect(screen.getByRole('link', { name: /#research/ })).toBeDefined()
  emit('agent.updated', { ...agent, name: 'Coordinator' }, 3)
  expect(screen.getByText('Unaddressed messages go to Coordinator')).toBeDefined()
})
test('switching rooms changes selection, messages query and readable direct title', async () => {
  const { router } = setup()
  await screen.findByText('Hello team')
  const link = screen.getByRole('link', { name: /Lead.*Working/ })
  link.focus()
  expect(document.activeElement).toBe(link)
  fireEvent.click(link)
  await screen.findByRole('heading', { name: 'Lead' })
  expect(router.state.location.pathname).toBe('/chat/direct-lead')
  expect(link.getAttribute('aria-current')).toBe('page')
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([path]) => String(path).includes('/direct-lead/messages')),
    ).toBe(true),
  )
})
test('cursor pagination prepends history, deduplicates overlaps and updates historical messages', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (...args) => {
    const url = String(args[0])
    if (!url.includes('/messages')) return original(...args)
    if (url.includes('before='))
      return response({
        asOfSeq: 1,
        items: [
          message,
          {
            ...message,
            id: 'history',
            parts: [{ kind: 'text', text: 'Earlier message' }],
            createdAt: '2026-10-08T08:00:00.000Z',
          },
        ],
        nextCursor: null,
      })
    return response({ asOfSeq: 1, items: [message], nextCursor: 'cursor +/=' })
  })
  setup()
  await screen.findByText('Hello team')
  const load = screen.getByRole('button', { name: 'Load older messages' })
  load.focus()
  fireEvent.click(load)
  await screen.findByText('Earlier message')
  expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Message history' }))
  expect(screen.getAllByText('Hello team')).toHaveLength(1)
  expect(screen.getAllByRole('article')[0]!.textContent).toContain('Earlier message')
  expect(
    fetchMock.mock.calls.some(([path]) => String(path).includes('before=cursor+%2B%2F%3D')),
  ).toBe(true)
  emit('message.delta', { messageId: 'history', roomId: 'general', append: ' updated' }, 2)
  expect(screen.getByText('Earlier message updated')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull()
})
test('renders every message part and keeps approval and plan placeholders passive', async () => {
  items = [
    MessageSchema.parse({
      ...message,
      parts: [
        { kind: 'text', text: 'Ready for review' },
        { kind: 'tools', summary: 'Ran 6 commands', runId: 'run' },
        { kind: 'file', path: 'src/feed.ts', added: 182, removed: 12 },
        { kind: 'review', verdict: 'changes_requested', taskId: null },
        { kind: 'approval', approvalId: 'approval' },
        {
          kind: 'plan',
          briefId: 'brief',
          lanes: [
            {
              agentId: 'lead',
              blocks: [
                {
                  id: 'block',
                  label: 'Review work',
                  state: 'working',
                  start: message.createdAt,
                  end: null,
                  taskId: null,
                  runId: null,
                },
              ],
            },
          ],
        },
      ],
    }),
  ]
  setup()
  await screen.findByText('Ready for review')
  for (const text of [
    'Ran 6 commands',
    'src/feed.ts',
    '+182',
    '−12',
    'Changes requested',
    'Approval requested',
    'Review work',
  ])
    expect(screen.getByText(text)).toBeDefined()
  expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Deny' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('Ready for review').parentElement?.getAttribute('aria-live')).toBe(
    'polite',
  )
})
test('reducers ignore other rooms, append missing text parts and exclude new messages from history', () => {
  const data = { items: [{ ...message, parts: [] }], nextCursor: null, typing: {} }
  const delta = {
    type: 'message.delta',
    seq: 2,
    ts: message.createdAt,
    data: { roomId: 'general', messageId: message.id, append: 'Text' },
  } as const
  expect(reduceMessages(data, delta, 'another', true)).toBe(data)
  expect(reduceMessages(data, delta, 'general', true).items[0]?.parts).toEqual([
    { kind: 'text', text: 'Text' },
  ])
  expect(
    reduceMessages(
      data,
      { type: 'message.created', seq: 3, ts: message.createdAt, data: message },
      'general',
      false,
    ),
  ).toBe(data)
})

test('buffers deltas during a snapshot fetch and ignores deltas already included in the snapshot', async () => {
  const original = fetchMock.getMockImplementation()!
  const pending = Promise.withResolvers<Response>()
  fetchMock.mockImplementation(async (...args) =>
    String(args[0]).includes('/messages')
      ? pending.promise.then((result) => result.clone())
      : original(...args),
  )
  setup()
  await screen.findByText('Loading messages…')
  emit('message.delta', { roomId: 'general', messageId: message.id, append: ' included' }, 2)
  emit('message.delta', { roomId: 'general', messageId: message.id, append: ' buffered' }, 3)
  await act(async () =>
    pending.resolve(
      response({
        asOfSeq: 2,
        items: [{ ...message, parts: [{ kind: 'text', text: 'Hello team included' }] }],
        nextCursor: null,
      }),
    ),
  )
  await screen.findByText('Hello team included buffered')
})

test('resync follows a changed pagination boundary without skipping messages', async () => {
  const original = fetchMock.getMockImplementation()!
  let cursor = 'first-cursor'
  fetchMock.mockImplementation(async (...args) => {
    const url = String(args[0])
    if (!url.includes('/messages')) return original(...args)
    if (url.includes('before='))
      return response({
        asOfSeq: 1,
        items: [
          {
            ...message,
            id: 'history',
            createdAt: '2026-10-08T08:00:00.000Z',
            parts: [
              {
                kind: 'text',
                text: url.includes('second-cursor') ? 'Fresh boundary' : 'Old boundary',
              },
            ],
          },
        ],
        nextCursor: null,
      })
    return response({ asOfSeq: 1, items: [message], nextCursor: cursor })
  })
  const { queries } = setup()
  await screen.findByRole('button', { name: 'Load older messages' })
  fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }))
  await screen.findByText('Old boundary')
  cursor = 'second-cursor'
  await act(async () => queries.register(messagesQuery('general')).refetch())
  await screen.findByText('Fresh boundary')
  expect(screen.queryByText('Old boundary')).toBeNull()
})

const panel = () => screen.findByRole('complementary', { name: 'About this room' })
test('side panels show empty states for every card', async () => {
  setup()
  const aside = within(await panel())
  expect(await aside.findByText('No files touched yet.')).toBeDefined()
  expect(aside.getByText('Nothing saved from this room yet.')).toBeDefined()
  expect(aside.getByText('Not mirrored to any channel.')).toBeDefined()
  expect(aside.getByRole('link', { name: 'Manage channels' }).getAttribute('href')).toBe(
    '/settings',
  )
})
test('side panels list files, learned facts with memory links, and channels', async () => {
  filesInPlay = ['api/events.py', 'web/feed.ts']
  learned = [
    { text: 'Page with a cursor.', savedTo: ['lead', 'ghost'], at: '2026-10-08T10:00:00.000Z' },
  ]
  rooms = [{ ...room, channels: [{ platform: 'telegram', label: 'Telegram topic' }] }]
  fetchMock.mockImplementation(async (input) => {
    const url = String(input)
    if (url === '/api/agents') return response({ asOfSeq: 1, items: [agent] })
    if (url === '/api/rooms') return response({ asOfSeq: 1, rooms, directs: [direct] })
    if (url.includes('/messages')) return response({ asOfSeq: 1, items, nextCursor: null })
    return response({ asOfSeq: 1, room: rooms[0], filesInPlay, learned })
  })
  setup()
  const aside = within(await panel())
  expect(await aside.findByText('api/events.py')).toBeDefined()
  expect(aside.getByText('web/feed.ts')).toBeDefined()
  expect(aside.getByText('Page with a cursor.')).toBeDefined()
  expect(aside.getByText('Saved to Lead’s and ghost’s memory')).toBeDefined()
  expect(aside.getByRole('link', { name: /Open memory/ }).getAttribute('href')).toBe('/team/lead')
  expect(await aside.findByText('Telegram topic')).toBeDefined()
})
test('side panels refetch when this room completes a message or saves a memory', async () => {
  setup()
  const aside = within(await panel())
  await aside.findByText('No files touched yet.')
  filesInPlay = ['src/new.ts']
  emit('message.completed', { messageId: 'other', roomId: 'elsewhere' }, 2)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(aside.queryByText('src/new.ts')).toBeNull()
  emit('message.completed', { messageId: 'message-one', roomId: 'general' }, 3)
  expect(await aside.findByText('src/new.ts')).toBeDefined()
  learned = [{ text: 'Fresh fact', savedTo: ['lead'], at: '2026-10-08T10:00:00.000Z' }]
  emit(
    'memory.saved',
    { agentIds: ['lead'], text: 'Fresh fact', source: { kind: 'room', roomId: 'general' } },
    4,
  )
  expect(await aside.findByText('Fresh fact')).toBeDefined()
})
test('the details toggle expands and collapses the side panels', async () => {
  setup()
  await panel()
  const toggle = screen.getByRole('button', { name: 'Show room details' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  expect(
    screen.getByRole('button', { name: 'Hide room details' }).getAttribute('aria-expanded'),
  ).toBe('true')
})
test('side panels show an error with retry when the room details fail', async () => {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input)
    if (url === '/api/agents') return response({ asOfSeq: 1, items: [agent] })
    if (url === '/api/rooms') return response({ asOfSeq: 1, rooms, directs: [direct] })
    if (url.includes('/messages')) return response({ asOfSeq: 1, items, nextCursor: null })
    return response({ error: { code: 'internal', message: 'x' } }, 500)
  })
  setup()
  const aside = within(await panel())
  expect(await aside.findByText('Could not load room details.')).toBeDefined()
  expect(aside.getByRole('button', { name: 'Try again' })).toBeDefined()
})
