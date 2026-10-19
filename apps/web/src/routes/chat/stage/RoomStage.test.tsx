import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Approval, Message, Room, StreamEvent } from '@score/contract'
import { createQueryClient, StreamContext } from '../../../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../../../data/resync.ts'
import { createStreamClient } from '../../../data/stream.ts'
import { onMention } from '../composer-mention.ts'
import { RoomStage } from './RoomStage.tsx'
import { StageToggle } from './StageToggle.tsx'
import { saveStageShown } from './stage-store.ts'

// PLAN 10.10: the stage reads the room's live state from the same streams the thread uses.
class Source extends EventTarget {
  static current: Source
  constructor() {
    super()
    Source.current = this
  }
  close() {}
}
const agent = (id: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: id,
  role: 'role',
  style: { color: '#6B4EFF', shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
  ...extra,
})
const agents = [agent('lead'), agent('builder'), agent('reviewer')]
const room: Room = {
  id: 'room-1',
  name: '#room',
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder', 'reviewer'],
  unread: 0,
  activeAgents: [],
  channels: [],
}
const message = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  roomId: 'room-1',
  author: { kind: 'agent', agentId: 'builder' },
  to: [],
  parts: [{ kind: 'text', text: 'hi' }],
  createdAt: '2026-10-19T10:00:00.000Z',
  streaming: false,
  refs: [],
  ...extra,
})
const approval = (extra: Partial<Approval> = {}): Approval => ({
  id: 'approval-1',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'reviewer',
  title: 'Run a command',
  command: 'pnpm add ws',
  cwd: null,
  description: '',
  choices: ['once', 'deny'],
  createdAt: '2026-10-19T10:00:00.000Z',
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: null,
  refs: [{ kind: 'room', roomId: 'room-1' }],
  ...extra,
})

let items: Message[]
let seq = 10
const disposers: (() => void)[] = []
const json = (payload: unknown) => new Response(JSON.stringify(payload))

function emit(type: StreamEvent['type'], data: unknown) {
  seq += 1
  act(() =>
    Source.current.dispatchEvent(
      new MessageEvent(type, {
        data: JSON.stringify({ type, data, seq, ts: '2026-10-19T10:00:00.000Z' }),
        lastEventId: String(seq),
      }),
    ),
  )
}

function mount(withToggle = false) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  disposers.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        {withToggle && <StageToggle />}
        <RoomStage room={room} agents={agents} />
      </StreamContext>
    </QueryClientProvider>,
  )
}
const mood = (id: string) =>
  screen.getByRole('button', { name: new RegExp(`^${id},`) }).getAttribute('data-mood')

beforeEach(() => {
  localStorage.clear()
  saveStageShown(true)
  items = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/approvals?'))
        return json({ asOfSeq: 1, items: [], nextCursor: null })
      return json({ asOfSeq: 1, items, nextCursor: null })
    }),
  )
})
afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.clear()
  saveStageShown(true)
  localStorage.clear()
})

test('members show up resting, then follow typing, streaming and approvals of this room', async () => {
  mount()
  await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(3))
  expect(['lead', 'builder', 'reviewer'].map(mood)).toEqual(['rest', 'rest', 'rest'])

  emit('typing', { roomId: 'room-1', agentId: 'lead', text: '' })
  expect(mood('lead')).toBe('think')
  emit('typing', { roomId: 'room-1', agentId: 'lead', text: 'is outlining the next steps' })
  expect(mood('lead')).toBe('work')
  emit('typing', { roomId: 'room-1', agentId: 'lead', text: null })
  expect(mood('lead')).toBe('rest')
  // Another room's typing is not this room's business.
  emit('typing', { roomId: 'room-2', agentId: 'lead', text: 'busy elsewhere' })
  expect(mood('lead')).toBe('rest')

  emit('message.created', message('m1', { streaming: true }))
  expect(mood('builder')).toBe('work')
  emit('message.completed', { messageId: 'm1', roomId: 'room-1' })
  expect(mood('builder')).toBe('rest')

  emit('approval.requested', approval())
  expect(mood('reviewer')).toBe('needs')
  expect(screen.getByRole('button', { name: 'reviewer, waiting for you' })).toBeDefined()
  emit('approval.updated', approval({ status: 'approved', actionable: false }))
  expect(mood('reviewer')).toBe('rest')
  emit(
    'approval.requested',
    approval({ id: 'approval-2', refs: [{ kind: 'room', roomId: 'room-2' }] }),
  )
  expect(mood('reviewer')).toBe('rest')
})

test('a message from one member that mentions another turns the two toward each other, not an old one', async () => {
  items = [message('old', { author: { kind: 'agent', agentId: 'lead' }, to: ['builder'] })]
  mount()
  await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(3))
  const facing = (id: string) =>
    screen.getByRole('button', { name: new RegExp(`^${id},`) }).getAttribute('data-facing')
  // What was there when the room opened is not replayed: the default is everyone looking right.
  expect(['lead', 'builder', 'reviewer'].map(facing)).toEqual(['right', 'right', 'right'])
  emit(
    'message.created',
    message('m2', {
      author: { kind: 'agent', agentId: 'reviewer' },
      to: ['lead'],
      createdAt: '2026-10-19T10:01:00.000Z',
    }),
  )
  // Reviewer stands right of lead: reviewer looks left, lead looks right.
  expect(facing('reviewer')).toBe('left')
  expect(facing('lead')).toBe('right')
})

test('clicking a member asks this room’s composer for its mention', async () => {
  mount()
  await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(3))
  const mine = vi.fn()
  const other = vi.fn()
  const stops = [onMention('room-1', mine), onMention('room-2', other)]
  fireEvent.click(screen.getByRole('button', { name: /^builder,/ }))
  stops.forEach((stop) => stop())
  expect(mine).toHaveBeenCalledWith('builder')
  expect(other).not.toHaveBeenCalled()
})

test('Hide stage removes the strip, is remembered, and Show stage brings it back', async () => {
  const first = mount(true)
  await waitFor(() => expect(screen.getByRole('group', { name: 'Room members' })).toBeDefined())
  const toggle = screen.getByRole('button', { name: 'Hide stage' })
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(toggle)
  expect(screen.queryByRole('group', { name: 'Room members' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Show stage' }).getAttribute('aria-expanded')).toBe(
    'false',
  )
  expect(localStorage.getItem('score.roomStage')).toBe('hidden')
  // A reload: the device remembers.
  first.unmount()
  mount(true)
  expect(screen.queryByRole('group', { name: 'Room members' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show stage' }))
  await waitFor(() => expect(screen.getByRole('group', { name: 'Room members' })).toBeDefined())
  expect(localStorage.getItem('score.roomStage')).toBeNull()
})

test('removed agents and unknown members are left out; a room with nobody to show has no strip', async () => {
  const gone = agent('builder', {
    lifecycle: {
      state: 'removed',
      incarnationId: '00000000-0000-4000-8000-000000000000',
      operationId: null,
    },
  })
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  disposers.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RoomStage room={room} agents={[agent('lead'), gone]} />
      </StreamContext>
    </QueryClientProvider>,
  )
  await waitFor(() => expect(screen.getAllByRole('button')).toHaveLength(1))
  expect(screen.getByRole('button', { name: /^lead,/ })).toBeDefined()
  view.rerender(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RoomStage room={room} agents={[]} />
      </StreamContext>
    </QueryClientProvider>,
  )
  expect(screen.queryByRole('group', { name: 'Room members' })).toBeNull()
})
