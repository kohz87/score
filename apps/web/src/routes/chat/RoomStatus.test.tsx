import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, Approval, Room, StreamEvent } from '@score/contract'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { RoomStatus } from './RoomStatus.tsx'

// The header line speaks from the stage's moods: busy members only, in the stage's words.
class Source extends EventTarget {
  static current: Source
  constructor() {
    super()
    Source.current = this
  }
  close() {}
}
const agent = (id: string): AgentSummary => ({
  id,
  name: id,
  role: 'role',
  style: { color: '#6B4EFF', shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
})
const agents = ['lead', 'builder', 'reviewer'].map(agent)
// The header and stage work from the room's live state, not from `activeAgents` (the sidebar's server-side copy of it).
const room: Room = {
  id: 'room-1',
  name: '#room',
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder', 'reviewer'],
  unread: 0,
  activeAgents: ['lead', 'builder'],
  channels: [],
}
const approval: Approval = {
  id: 'approval-1',
  origin: 'score-run',
  phase: 'human_pending',
  status: 'pending',
  actionable: true,
  linkedTo: null,
  agentId: 'reviewer',
  title: 'Run',
  command: 'x',
  cwd: null,
  description: '',
  choices: ['once', 'deny'],
  createdAt: '2026-10-19T10:00:00.000Z',
  expiresAt: null,
  decision: null,
  delivery: 'none',
  blocking: null,
  refs: [{ kind: 'room', roomId: 'room-1' }],
}
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

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith('/api/approvals?')
        ? json({ asOfSeq: 1, items: [], nextCursor: null })
        : json({ asOfSeq: 1, items: [], nextCursor: null }),
    ),
  )
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  disposers.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RoomStatus room={room} agents={agents} />
      </StreamContext>
    </QueryClientProvider>,
  )
})
afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

test('resting members are not listed, even when the room says they wrote lately', async () => {
  await waitFor(() => expect(screen.getByRole('list', { name: 'Working now' })).toBeDefined())
  expect(
    within(screen.getByRole('list', { name: 'Working now' })).queryAllByRole('listitem'),
  ).toHaveLength(0)
})

test('thinking, working and waiting for you are listed in the stage’s words', async () => {
  await waitFor(() => expect(screen.getByRole('list', { name: 'Working now' })).toBeDefined())
  const list = screen.getByRole('list', { name: 'Working now' })
  emit('typing', { roomId: 'room-1', agentId: 'lead', text: '' })
  expect(within(list).getByText('lead').closest('li')!.textContent).toContain('Thinking…')
  emit('typing', { roomId: 'room-1', agentId: 'builder', text: 'is writing code' })
  expect(within(list).getByText('builder').closest('li')!.textContent).toMatch(/\S+…?/)
  expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  emit('approval.requested', approval)
  expect(within(list).getByText('reviewer').closest('li')!.textContent).toContain('Waiting for you')
  emit('typing', { roomId: 'room-1', agentId: 'lead', text: null })
  expect(within(list).queryByText('lead')).toBeNull()
})
