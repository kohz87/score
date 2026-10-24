import type { AgentSummary, Exchange, Job, Message, Room } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { vi } from 'vitest'
import type { ReactNode } from 'react'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../../data/resync.ts'
import type { StreamClient } from '../../data/stream.ts'

export const agents: AgentSummary[] = [
  {
    id: 'lead',
    name: 'lead',
    role: 'Leads the team',
    style: { color: '#6B4EFF', shape: 'circle-dot' },
    status: 'idle',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
  {
    id: 'builder',
    name: 'builder',
    role: 'Builds features',
    style: { color: '#19C39A', shape: 'triangle' },
    status: 'working',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
  {
    id: 'reviewer',
    name: 'reviewer',
    role: 'Reviews changes',
    style: { color: '#FFB61E', shape: 'diamond' },
    status: 'idle',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
]

export const room: Room = {
  id: 'room-1',
  name: 'Team room',
  kind: 'room',
  leadAgentId: 'lead',
  members: agents.map((agent) => agent.id),
  unread: 0,
  activeAgents: [],
  channels: [],
  role: 'team',
  routing: 'exchanges',
}

export function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    roomId: room.id,
    title: 'Activity feed',
    state: 'working',
    holderAgentId: 'builder',
    isDefault: false,
    exchangeBudget: 8,
    jobTurnLimit: 40,
    unread: 0,
    activeAgents: [],
    lastMessageAt: null,
    messageCount: 0,
    summary: null,
    source: null,
    reportBack: null,
    createdAt: '2026-10-24T09:00:00.000Z',
    updatedAt: '2026-10-24T09:05:00.000Z',
    ...overrides,
  }
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    roomId: room.id,
    jobId: 'job-1',
    author: { kind: 'you' },
    to: ['lead'],
    parts: [{ kind: 'text', text: 'Build the activity feed.' }],
    createdAt: '2026-10-24T09:01:00.000Z',
    streaming: false,
    refs: [],
    ...overrides,
  }
}

export function makeExchange(overrides: Partial<Exchange> = {}): Exchange {
  return {
    id: 'exchange-1',
    jobId: 'job-1',
    roomId: room.id,
    kind: 'review',
    parentId: null,
    from: 'builder',
    to: 'reviewer',
    state: 'paused_budget',
    round: 1,
    turnsUsed: 8,
    budget: 8,
    outcome: null,
    endedReason: null,
    pause: {
      reason: 'exchange_budget',
      options: ['more_turns', 'lead_decides', 'step_in', 'stop'],
    },
    queuedBehind: null,
    createdAt: '2026-10-24T09:02:00.000Z',
    updatedAt: '2026-10-24T09:04:00.000Z',
    ...overrides,
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function renderInRoom(ui: ReactNode, entries: string[] = ['/b?room=room-1']) {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  const stream = {
    subscribe: () => () => undefined,
    onControl: () => () => undefined,
  } as unknown as StreamClient
  const queries = createStreamQueryRegistry(queryClient, stream, immediateFrameScheduler)
  const result = render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream, queries }}>
        <MemoryRouter initialEntries={entries}>{ui}</MemoryRouter>
      </StreamContext>
    </QueryClientProvider>,
  )
  return { ...result, queryClient, queries }
}

export function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init ?? {})),
  )
}

export function disposeRoomTest() {
  cleanup()
}
