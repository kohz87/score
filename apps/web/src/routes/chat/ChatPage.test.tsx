import { StrictMode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  type AgentSummary,
  type Approval,
  type LaneBlock,
  type Message,
  type RewindPlan,
  type RoomDeletePlan,
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
import { reduceMessages, roomsQuery } from './queries.ts'

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
let shares: object[] = []
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
let roomCalls: [string, string, unknown][]
let deletePlan: RoomDeletePlan
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
  shares = []
  filesInPlay = []
  learned = []
  roomCalls = []
  deletePlan = { name: 'general', messages: 12, files: 2, runs: 3, briefs: 1, blocked: null }
  fetchMock = vi.fn(async (input, init) => {
    const url = String(input)
    if (
      (init?.method === 'PATCH' || init?.method === 'DELETE') &&
      init.body &&
      url === '/api/rooms/general'
    )
      roomCalls.push([init.method, url, JSON.parse(String(init.body))])
    if (url.endsWith('/delete-plan')) return response(deletePlan)
    if (init?.method === 'DELETE' && url === '/api/rooms/general')
      return new Response(null, { status: 204 })
    if (init?.method === 'PATCH' && url === '/api/rooms/general') return response(room)
    if (url.startsWith('/api/approvals?'))
      return response({ asOfSeq: 1, items: [pendingApproval], nextCursor: null })
    if (url.startsWith('/api/search/messages')) return response({ items: searchHits })
    if (url === '/api/agents') return response({ asOfSeq: 1, items: [agent] })
    if (url === '/api/rooms') return response({ asOfSeq: 1, rooms, directs: [direct] })
    if (url.endsWith('/versions')) return response({ asOfSeq: 1, items: versions })
    if (url.includes('/versions/')) return response({ version: versions[0], items: versionItems })
    if (url.endsWith('/shares')) return response({ items: shares })
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
test('actions show on hover or focus and always on touch devices', () => {
  const css = readFileSync('src/routes/chat/chat.css', 'utf8')
  expect(css).toMatch(/\.chat-message:hover \.chat-message-actions[^{]*\{\s*opacity: 1/)
  expect(css).toMatch(/\.chat-message:focus-within \.chat-message-actions/)
  expect(css).toMatch(/@media \(hover: none\) \{\s*\.chat-message-actions \{\s*opacity: 1/)
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
test('a chain of three edits steps 1 / 3, 2 / 3, 3 / 3', async () => {
  const third: Message = {
    ...mine,
    id: 'm3',
    createdAt: '2026-10-08T10:09:00.000Z',
    parts: [{ kind: 'text', text: 'Third wording' }],
  }
  const second: Message = {
    ...mine,
    id: 'm2',
    createdAt: '2026-10-08T10:06:00.000Z',
    parts: [{ kind: 'text', text: 'Second wording' }],
  }
  items = [third]
  versions = [
    { ...editVersion, id: 'v2', anchorId: 'm2', replacedBy: 'm3', number: 2, count: 3 },
    { ...editVersion, id: 'v1', replacedBy: 'm2', number: 1, count: 3 },
  ]
  versionItems = [second]
  fetchMock.mockImplementation(
    ((impl) => async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/versions/m2')) return response({ version: versions[0], items: [second] })
      if (url.endsWith('/versions/mine')) return response({ version: versions[1], items: [mine] })
      return impl(input)
    })(fetchMock.getMockImplementation()!),
  )
  setup()
  await screen.findByText('Third wording')
  fireEvent.click(screen.getByRole('button', { name: 'Previous version' }))
  expect(await screen.findByText('Second wording')).toBeDefined()
  expect(screen.getByText(/Viewing version 2 of 3/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Previous version' }))
  expect(await screen.findByText('Ship it')).toBeDefined()
  expect(screen.getByText(/Viewing version 1 of 3/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Next version' }))
  expect(await screen.findByText('Second wording')).toBeDefined()
})
test('room.version.created for a delete adds nothing until deleted messages are shown', async () => {
  setup()
  await screen.findByText('Hello team')
  emit(
    'room.version.created',
    { ...editVersion, mode: 'delete', count: 1, anchorCreatedAt: '2026-10-08T09:59:00.000Z' },
    10,
  )
  expect(screen.queryByTestId('deleted-messages')).toBeNull()
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

test('your own message arriving on the stream replaces its "sending" copy, so it never shows twice', () => {
  const sending: Message = {
    ...message,
    id: 'pending-abc',
    author: { kind: 'you' },
    parts: [{ kind: 'text', text: 'Second wording' }],
  }
  const stored: Message = { ...sending, id: 'm-stored' }
  const other: Message = { ...sending, id: 'pending-def', parts: [{ kind: 'text', text: 'Other' }] }
  const data = { items: [sending, other], nextCursor: null, typing: {} }
  const created = {
    type: 'message.created',
    seq: 3,
    ts: message.createdAt,
    data: stored,
  } as StreamEvent
  expect(reduceMessages(data, created, 'general', true).items.map((item) => item.id)).toEqual([
    'm-stored',
    'pending-def',
  ])
})
