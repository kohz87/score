import { StrictMode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  MessageSchema,
  type AgentSummary,
  type Approval,
  type LaneBlock,
  type Message,
  type RewindPlan,
  type Room,
  type RoomVersion,
  type StreamEvent,
} from '@score/contract'
import { App, appRoutes } from '../../App.tsx'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { readFileSync } from 'node:fs'
import { resetMessageDeletion } from './message-deletion.ts'
import { stopEdit } from './message-edit.ts'
import { messagesQuery, reduceMessages, roomsQuery } from './queries.ts'

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
const pendingApproval: Approval = {
  id: 'approval',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'lead',
  title: 'Approval requested',
  command: 'pnpm add ws',
  cwd: null,
  description: '',
  choices: ['once', 'deny'],
  createdAt: '2026-10-08T10:00:00.000Z',
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: null,
  refs: [],
}
let items: Message[]
let versions: RoomVersion[]
let versionItems: Message[]
let plan: RewindPlan
let rewindResponse: () => Response
let searchHits: unknown[] = []
let rooms: Room[]
let filesInPlay: string[]
let learned: { text: string; savedTo: string[]; at: string }[]
function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status })
}
function setup(path = '/chat/general') {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
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
  versions = []
  versionItems = []
  plan = {
    hiddenCount: 2,
    blocked: null,
    agents: [{ agentId: 'lead', turns: 2, cannot: null }],
  }
  rewindResponse = () => response({})
  searchHits = []
  rooms = [room]
  filesInPlay = []
  learned = []
  fetchMock = vi.fn(async (input) => {
    const url = String(input)
    if (url.startsWith('/api/approvals?'))
      return response({ asOfSeq: 1, items: [pendingApproval], nextCursor: null })
    if (url.startsWith('/api/search/messages')) return response({ items: searchHits })
    if (url === '/api/agents') return response({ asOfSeq: 1, items: [agent] })
    if (url === '/api/rooms') return response({ asOfSeq: 1, rooms, directs: [direct] })
    if (url.endsWith('/versions')) return response({ asOfSeq: 1, items: versions })
    if (url.includes('/versions/')) return response({ version: versions[0], items: versionItems })
    if (url.endsWith('/rewind-plan')) return response(plan)
    if (url.endsWith('/rewind')) return rewindResponse()
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
  vi.useRealTimers()
  resetMessageDeletion()
  stopEdit()
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
test('completion replaces the cached parts with the final ones (plan card, tools summary)', async () => {
  const { queryClient } = setup()
  await screen.findByText('Hello team')
  emit(
    'message.completed',
    {
      roomId: 'general',
      messageId: message.id,
      parts: [
        { kind: 'text', text: 'Hello team' },
        { kind: 'tools', summary: 'Ran 2 commands', runId: 'run-1' },
      ],
    },
    2,
  )
  expect(queryClient.getQueryData(messagesQuery('general').key)).toMatchObject({
    data: { items: [{ streaming: false, parts: [{ kind: 'text' }, { kind: 'tools' }] }] },
  })
})
test('stream appends once, completes messages and clears typing and unread via room updates', async () => {
  const { queryClient } = setup()
  await screen.findByText('Hello team')
  emit('message.delta', { roomId: 'general', messageId: message.id, append: '!' }, 2)
  emit('message.delta', { roomId: 'general', messageId: message.id, append: '!' }, 2)
  // Streaming text is shown once per animation frame.
  expect(await screen.findByText('Hello team!')).toBeDefined()
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
  expect(await screen.findByText('Earlier message updated')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull()
})
test('renders every message part and shows approval and plan cards', async () => {
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
    'Review work',
  ])
    expect(screen.getByText(text)).toBeDefined()
  expect(await screen.findByRole('button', { name: 'Approve' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Deny' })).toBeDefined()
  expect(
    screen.getByText('Ready for review').closest('.chat-message-parts')?.getAttribute('aria-live'),
  ).toBe('polite')
})
test('lane.upserted updates the plan block of its brief live', () => {
  const block: LaneBlock = {
    id: 'b1',
    label: 'Old',
    state: 'planned',
    start: message.createdAt,
    end: null,
    taskId: null,
    runId: null,
    kind: 'task',
  }
  const data = {
    items: [
      {
        ...message,
        parts: [
          {
            kind: 'plan' as const,
            briefId: 'brief',
            lanes: [{ agentId: 'lead', blocks: [block] }],
          },
        ],
      },
    ],
    nextCursor: null,
    typing: {},
  }
  const lane = (briefId: string | null, agentId: string, next: typeof block) =>
    ({
      type: 'lane.upserted',
      seq: 2,
      ts: message.createdAt,
      data: { briefId, agentId, block: next },
    }) as StreamEvent
  const plan = (event: StreamEvent) => {
    const part = reduceMessages(data, event, 'general', true).items[0]!.parts[0]
    return part?.kind === 'plan' ? part.lanes : []
  }
  expect(
    plan(lane('brief', 'lead', { ...block, label: 'New', state: 'working' }))[0]!.blocks,
  ).toEqual([{ ...block, label: 'New', state: 'working' }])
  expect(plan(lane('brief', 'lead', { ...block, id: 'b2' }))[0]!.blocks).toHaveLength(2)
  expect(plan(lane('brief', 'builder', block))).toHaveLength(2)
  expect(plan(lane('other', 'lead', { ...block, label: 'No' }))[0]!.blocks[0]!.label).toBe('Old')
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

const sent = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
test('Delete hides the message at once, Undo brings it back and nothing is sent', async () => {
  items = [{ ...message, streaming: false }]
  setup()
  await screen.findByText('Hello team')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fireEvent.click(screen.getByRole('button', { name: 'Delete message from Lead' }))
  expect(screen.queryByText('Hello team')).toBeNull()
  const toast = screen.getByText(/Message deleted/)
  expect(toast).toBeDefined()
  expect(screen.getByText('Removes it from Score. Agents may still remember it.')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(screen.getByText('Hello team')).toBeDefined()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(7000)
  })
  expect(sent()).toHaveLength(0)
})
test('the DELETE is sent when the undo window ends; a failure brings the message back', async () => {
  items = [{ ...message, streaming: false }]
  setup()
  await screen.findByText('Hello team')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fireEvent.click(screen.getByRole('button', { name: 'Delete message from Lead' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5900)
  })
  expect(sent()).toHaveLength(0)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(sent()).toHaveLength(1)
  expect(String(sent()[0]![0])).toBe('/api/rooms/general/messages/message-one')
  expect(screen.queryByText('Hello team')).toBeNull()
  // Server confirms through the stream.
  emit('message.deleted', { roomId: 'general', messageId: 'message-one' }, 5)
  expect(screen.queryByText('Hello team')).toBeNull()
})
test('a streaming message has no Delete action, and message.deleted removes a cached message', () => {
  const data = { items: [message, { ...message, id: 'other' }], nextCursor: null, typing: {} }
  const event = {
    type: 'message.deleted',
    seq: 2,
    ts: message.createdAt,
    data: { roomId: 'general', messageId: 'other' },
  } as const
  expect(reduceMessages(data, event, 'general', true).items.map((item) => item.id)).toEqual([
    'message-one',
  ])
  expect(reduceMessages(data, event, 'another', true)).toBe(data)
})
test('a streaming message offers no Delete', async () => {
  setup()
  await screen.findByText('Hello team')
  expect(screen.queryByRole('button', { name: /Delete message/ })).toBeNull()
})

// PLAN 5.24: actions under each message.
const mine: Message = {
  ...message,
  id: 'mine',
  author: { kind: 'you' },
  to: ['lead'],
  parts: [{ kind: 'text', text: 'Ship it' }],
  streaming: false,
  createdAt: '2026-10-08T10:00:01.000Z',
}
const reply: Message = {
  ...message,
  id: 'reply',
  parts: [{ kind: 'text', text: 'Shipped **now**' }],
  streaming: false,
  createdAt: '2026-10-08T10:00:02.000Z',
}
const buttons = (article: HTMLElement) =>
  within(article)
    .getAllByRole('button')
    .map((button) => button.textContent)
test('finished messages get an action row below the body, per author; streaming ones none', async () => {
  items = [mine, reply, { ...message, id: 'writing', createdAt: '2026-10-08T10:00:03.000Z' }]
  setup()
  await screen.findByText('Ship it')
  const articles = screen.getAllByRole('article')
  expect(buttons(articles[0]!)).toEqual(['Edit', 'Copy', 'Delete'])
  expect(buttons(articles[1]!)).toEqual(['Copy', 'Retry', 'Delete'])
  // A reply being written has Stop, and none of the finished-message actions.
  expect(buttons(articles[2]!)).toEqual(['Stop'])
  // Below the body, never inside the header that holds the timestamp.
  const meta = articles[0]!.querySelector('.chat-message-meta')!
  expect(meta.querySelector('button')).toBeNull()
  expect(
    articles[0]!
      .querySelector('.chat-message-parts')!
      .compareDocumentPosition(articles[0]!.querySelector('.chat-message-actions')!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
})
test('actions show on hover or focus and always on touch devices', () => {
  const css = readFileSync('src/routes/chat/chat.css', 'utf8')
  expect(css).toMatch(/\.chat-message:hover \.chat-message-actions[^{]*\{\s*opacity: 1/)
  expect(css).toMatch(/\.chat-message:focus-within \.chat-message-actions/)
  expect(css).toMatch(/@media \(hover: none\) \{\s*\.chat-message-actions \{\s*opacity: 1/)
})
test('Copy puts the Markdown source on the clipboard and says Copied for two seconds', async () => {
  items = [reply]
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  setup()
  await screen.findByText('now')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy message from Lead' }))
  })
  expect(writeText).toHaveBeenCalledWith('Shipped **now**')
  expect(screen.getByRole('button', { name: 'Copy message from Lead' }).textContent).toBe('Copied')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100)
  })
  expect(screen.getByRole('button', { name: 'Copy message from Lead' }).textContent).toBe('Copy')
})
test('Retry posts to the retry endpoint with an idempotency key; a 409 explains itself', async () => {
  items = [reply]
  setup()
  await screen.findByText('now')
  const retries = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/retry'))
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (input, init) =>
    String(input).endsWith('/retry')
      ? response({ messageId: 'reply-2' }, 202)
      : original(input, init),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Retry reply from Lead' }))
  await waitFor(() => expect(retries()).toHaveLength(1))
  const [url, init] = retries()[0]!
  expect(String(url)).toBe('/api/rooms/general/messages/reply/retry')
  expect(init?.method).toBe('POST')
  expect(new Headers(init?.headers).get('Idempotency-Key')).toBeTruthy()
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Retry reply/ }).textContent).toBe('Retrying'),
  )
  await waitFor(
    () => expect(screen.getByRole('button', { name: /Retry reply/ }).textContent).toBe('Retry'),
    { timeout: 3000 },
  )
  fetchMock.mockImplementation(async (input, init) =>
    String(input).endsWith('/retry')
      ? response({ error: { code: 'conflict', message: 'busy' } }, 409)
      : original(input, init),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Retry reply from Lead' }))
  expect((await screen.findByRole('alert')).textContent).toMatch(/Can’t retry right now/)
})
test('Edit loads text and recipients into the composer; Cancel restores the draft', async () => {
  items = [mine]
  setup()
  await screen.findByText('Ship it')
  const box = screen.getByRole('combobox') as HTMLTextAreaElement
  fireEvent.change(box, { target: { value: 'half typed' } })
  fireEvent.click(screen.getByRole('button', { name: 'Edit message from You' }))
  expect(screen.getByText('Editing your message')).toBeDefined()
  expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe('Ship it')
  expect(screen.getByRole('button', { name: 'Remove Lead' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByText('Editing your message')).toBeNull()
  expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe('half typed')
  expect(screen.queryByRole('button', { name: 'Remove Lead' })).toBeNull()
})
const editVersion: RoomVersion = {
  id: 'v1',
  roomId: 'general',
  anchorId: 'mine',
  anchorCreatedAt: '2026-10-08T10:00:00.000Z',
  mode: 'edit',
  replacedBy: null,
  number: 1,
  count: 2,
  hiddenCount: 2,
  rewound: [{ agentId: 'lead', turnsUndone: 2 }],
  skipped: [],
  createdAt: '2026-10-08T10:05:00.000Z',
}
test('sending an edit posts `edits`; the original greys with a link to the new version', async () => {
  items = [mine]
  setup()
  await screen.findByText('Ship it')
  const original = fetchMock.getMockImplementation()!
  const created: Message = {
    ...mine,
    id: 'mine-2',
    edits: 'mine',
    parts: [{ kind: 'text', text: 'Ship it today' }],
  }
  fetchMock.mockImplementation(async (input, init) =>
    String(input) === '/api/rooms/general/messages' && init?.method === 'POST'
      ? response({ message: created, routedTo: ['lead'], command: null })
      : original(input, init),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Edit message from You' }))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Ship it today' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send correction' }))
  // The confirmation says what happens, then the room is rewound and the correction is posted.
  const dialog = await screen.findByRole('dialog', { name: 'Edit and send again?' })
  expect(await within(dialog).findByText(/Lead −2 turns/)).toBeDefined()
  expect(within(dialog).getByText(/Long-term memory .* is not rewound/)).toBeDefined()
  rewindResponse = () =>
    response({
      version: { ...editVersion },
      rewound: [{ agentId: 'lead', turnsUndone: 2 }],
      skipped: [],
    })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rewind and edit' }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === '/api/rooms/general/messages' && init?.method === 'POST',
      ),
    ).toBe(true),
  )
  const rewindCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/mine/rewind'))!
  expect(JSON.parse(String(rewindCall[1]!.body))).toEqual({ mode: 'edit' })
  const post = fetchMock.mock.calls.find(
    ([url, init]) => String(url) === '/api/rooms/general/messages' && init?.method === 'POST',
  )!
  expect(JSON.parse(String(post[1]!.body))).toEqual({
    text: 'Ship it today',
    to: ['lead'],
    edits: 'mine',
  })
  await waitFor(() => expect(screen.queryByText('Editing your message')).toBeNull())
  emit('message.updated', { roomId: 'general', messageId: 'mine', editedBy: 'mine-2' }, 9)
  const first = screen.getAllByRole('article')[0]!
  expect(within(first).getByText('edited')).toBeDefined()
  expect(first.className).toContain('chat-message--edited')
  expect(within(first).queryByRole('button', { name: /^Edit message/ })).toBeNull()
  const scroll = vi.fn()
  const target = document.getElementById('message-mine-2')!
  target.scrollIntoView = scroll
  fireEvent.click(within(first).getByRole('button', { name: 'see the new version' }))
  expect(scroll).toHaveBeenCalled()
})
test('an agent that cannot be rewound blocks Rewind and offers Hide in Score only', async () => {
  items = [mine]
  plan = {
    hiddenCount: 3,
    blocked: null,
    agents: [
      { agentId: 'lead', turns: 1, cannot: null },
      { agentId: 'builder', turns: 1, cannot: 'compressed' },
    ],
  }
  setup()
  await screen.findByText('Ship it')
  fireEvent.click(screen.getByRole('button', { name: 'Delete message from You' }))
  const dialog = await screen.findByRole('dialog', { name: 'Delete this message?' })
  await within(dialog).findByText(/These agents cannot be rewound/)
  expect(within(dialog).getByText(/builder: its Hermes session was compressed/)).toBeDefined()
  expect(
    (within(dialog).getByRole('button', { name: 'Rewind and delete' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
  rewindResponse = () =>
    response({
      version: { ...editVersion, mode: 'delete', replacedBy: null, count: 1 },
      rewound: [],
      skipped: [],
    })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Hide in Score only' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/mine/rewind'))!
  expect(JSON.parse(String(call[1]!.body))).toEqual({ mode: 'delete', scoreOnly: true })
})
test('a refused rewind says nothing was hidden and keeps the dialog', async () => {
  items = [mine]
  setup()
  await screen.findByText('Ship it')
  fireEvent.click(screen.getByRole('button', { name: 'Delete message from You' }))
  const dialog = await screen.findByRole('dialog', { name: 'Delete this message?' })
  await within(dialog).findByText(/Lead −2 turns/)
  rewindResponse = () =>
    response(
      {
        error: {
          code: 'rewind_incomplete',
          message: 'Some agents could not be rewound',
          details: { skipped: [{ agentId: 'lead', reason: 'no_answer' }], rewound: [] },
        },
      },
      409,
    )
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rewind and delete' }))
  await within(dialog).findByText(/Nothing was hidden/)
  expect(within(dialog).getByText(/Lead: Hermes did not answer in time/)).toBeDefined()
  expect(within(dialog).getByRole('button', { name: 'Hide in Score only' })).toBeDefined()
})
test('a blocked rewind explains why and cannot be confirmed', async () => {
  items = [mine]
  plan = { hiddenCount: 1, blocked: 'An agent is still answering', agents: [] }
  setup()
  await screen.findByText('Ship it')
  fireEvent.click(screen.getByRole('button', { name: 'Delete message from You' }))
  const dialog = await screen.findByRole('dialog', { name: 'Delete this message?' })
  await within(dialog).findByText(/An agent is still answering/)
  expect(
    (within(dialog).getByRole('button', { name: 'Rewind and delete' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true)
})
test('the version switcher sits above a correction and shows the previous version read-only', async () => {
  const correction: Message = {
    ...mine,
    id: 'mine-2',
    createdAt: '2026-10-08T10:06:00.000Z',
    edits: 'mine',
    parts: [{ kind: 'text', text: 'Ship it today' }],
  }
  items = [correction]
  versions = [{ ...editVersion, replacedBy: 'mine-2' }]
  versionItems = [mine, { ...reply, createdAt: '2026-10-08T10:01:00.000Z' }]
  setup()
  await screen.findByText('Ship it today')
  const switcher = await screen.findByTestId('version-switcher')
  expect(within(switcher).getByText('Version 2 of 2')).toBeDefined()
  fireEvent.click(within(switcher).getByRole('button', { name: 'Previous version' }))
  const previous = await within(switcher).findByRole('region', { name: 'Previous version' })
  expect(within(switcher).getByText('Version 1 of 2')).toBeDefined()
  expect(await within(previous).findByText('Ship it')).toBeDefined()
  // Greyed and read-only: none of the message actions.
  expect(within(previous).queryByRole('button', { name: /^Edit message/ })).toBeNull()
  expect(within(previous).queryByRole('button', { name: /^Delete message/ })).toBeNull()
  fireEvent.click(within(switcher).getByRole('button', { name: 'Next version' }))
  expect(within(switcher).queryByRole('region', { name: 'Previous version' })).toBeNull()
  expect(within(switcher).getByText('Version 2 of 2')).toBeDefined()
})
test('a delete leaves a Previous version marker where the message was', async () => {
  versions = [
    { ...editVersion, mode: 'delete', count: 1, anchorCreatedAt: '2026-10-08T09:59:00.000Z' },
  ]
  versionItems = [mine]
  setup()
  await screen.findByText('Hello team')
  const switcher = await screen.findByTestId('version-switcher')
  expect(within(switcher).getByText('Previous version')).toBeDefined()
  fireEvent.click(within(switcher).getByRole('button', { name: 'View' }))
  expect(await within(switcher).findByText('Ship it')).toBeDefined()
  fireEvent.click(within(switcher).getByRole('button', { name: 'Hide' }))
  expect(within(switcher).queryByText('Ship it')).toBeNull()
})
test('room.version.created adds the marker live', async () => {
  setup()
  await screen.findByText('Hello team')
  expect(screen.queryByTestId('version-switcher')).toBeNull()
  emit(
    'room.version.created',
    { ...editVersion, mode: 'delete', count: 1, anchorCreatedAt: '2026-10-08T09:59:00.000Z' },
    10,
  )
  expect(await screen.findByTestId('version-switcher')).toBeDefined()
})
test('message.updated sets editedBy on the cached original only', () => {
  const data = { items: [mine, reply], nextCursor: null, typing: {} }
  const event = {
    type: 'message.updated',
    seq: 2,
    ts: mine.createdAt,
    data: { roomId: 'general', messageId: 'mine', editedBy: 'n' },
  } as const
  const next = reduceMessages(data, event, 'general', true)
  expect(next.items[0]!.editedBy).toBe('n')
  expect(next.items[1]).toBe(reply)
})

test('searching messages lists hits that open the room at that message', async () => {
  searchHits = [
    {
      messageId: 'message-one',
      roomId: 'general',
      roomName: 'general',
      author: { kind: 'agent', agentId: 'lead' },
      createdAt: '2026-10-08T10:00:00.000Z',
      snippet: 'say [[hello]] to the team',
    },
  ]
  const { router } = setup('/chat')
  fireEvent.change(await screen.findByRole('searchbox', { name: 'Search messages' }), {
    target: { value: 'hello' },
  })
  const results = await screen.findByRole('list', { name: 'Search results' })
  expect((await within(results).findByText('hello')).tagName).toBe('MARK')
  expect(
    fetchMock.mock.calls.some(([url]) => String(url) === '/api/search/messages?q=hello&limit=20'),
  ).toBe(true)
  fireEvent.click(within(results).getByRole('link'))
  await waitFor(() => expect(router.state.location.pathname).toBe('/chat/general'))
  expect(router.state.location.search).toBe('?message=message-one')
})
test('opening a search hit scrolls to that message and highlights it', async () => {
  const scroll = vi.fn()
  Element.prototype.scrollIntoView = scroll
  try {
    items = [
      message,
      { ...message, id: 'target', streaming: false, parts: [{ kind: 'text', text: 'The needle' }] },
    ]
    setup('/chat/general?message=target')
    await screen.findByText('The needle')
    await waitFor(() => expect(scroll).toHaveBeenCalled())
    expect(document.getElementById('message-target')!.className).toContain('chat-message--hit')
    expect(document.getElementById('message-message-one')!.className).not.toContain(
      'chat-message--hit',
    )
  } finally {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  }
})
test('project events keep the rooms list and its projects current', () => {
  const data = { rooms: [room], directs: [direct], projects: [] }
  const project = { id: 'p1', name: 'Launch', color: '#6B4EFF' }
  const upserted = roomsQuery.reduce(data, {
    type: 'room-project.upserted',
    seq: 2,
    ts: message.createdAt,
    data: project,
  })
  expect(upserted.projects).toEqual([project])
  const moved = roomsQuery.reduce(upserted, {
    type: 'room.upserted',
    seq: 3,
    ts: message.createdAt,
    data: { ...room, projectId: 'p1', pinned: true },
  })
  expect(moved.rooms[0]).toMatchObject({ projectId: 'p1', pinned: true })
  expect(moved.projects).toEqual([project])
  const deleted = roomsQuery.reduce(moved, {
    type: 'room-project.deleted',
    seq: 4,
    ts: message.createdAt,
    data: { id: 'p1' },
  })
  expect(deleted.projects).toEqual([])
})
