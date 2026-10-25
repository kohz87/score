import type { AgentSummary, Job, Room, StreamEvent } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, test } from 'vitest'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import type { StreamQueryRegistry } from '../data/resync.ts'
import type { StreamClient } from '../data/stream.ts'
import { useBoldDirectChats, useBoldTeamRoom } from './bold-search-queries.ts'

const teamRoom: Room = {
  id: 'team-room',
  name: 'Team room',
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead'],
  unread: 0,
  activeAgents: [],
  channels: [],
  role: 'team',
  routing: 'exchanges',
}

const lead: AgentSummary = {
  id: 'lead',
  name: 'lead',
  role: 'Leads the team',
  style: { color: '#6B4EFF', shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
}

const job = (id: string, roomId: string, title: string): Job => ({
  id,
  roomId,
  title,
  state: 'working',
  holderAgentId: 'lead',
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
  spendCapUsd: null,
  recipe: null,
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
})

function setup() {
  const queryClient = createQueryClient()
  const listeners = new Set<(event: StreamEvent) => void>()
  const stream = {
    subscribe(listener: (event: StreamEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onControl: () => () => undefined,
  } as unknown as StreamClient
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream, queries: {} as StreamQueryRegistry }}>
        {children}
      </StreamContext>
    </QueryClientProvider>
  )
  return {
    queryClient,
    wrapper,
    listenerCount: () => listeners.size,
    emit(event: StreamEvent) {
      for (const listener of listeners) listener(event)
    },
  }
}

test('job.deleted leaves the team-room and one-to-one search caches while they are mounted', async () => {
  const { queryClient, wrapper, emit, listenerCount } = setup()
  const teamJob = job('team-job', teamRoom.id, 'Release notes')
  const directJob = job('direct-job', 'direct-lead', 'Catch up')
  queryClient.setQueryData(['bold-search', 'team-room'], {
    asOfSeq: 1,
    room: teamRoom,
    jobs: [teamJob],
  })
  queryClient.setQueryData(
    ['bold-search', 'directs', 'lead'],
    [{ agentId: 'lead', chats: [directJob] }],
  )
  const { result } = renderHook(
    () => ({ team: useBoldTeamRoom(), directs: useBoldDirectChats([lead]) }),
    { wrapper },
  )
  expect(listenerCount()).toBe(2)

  act(() =>
    emit({
      seq: 2,
      ts: '2026-10-24T10:01:00.000Z',
      type: 'job.deleted',
      data: { id: teamJob.id, roomId: teamRoom.id },
    }),
  )
  expect(queryClient.getQueryData(['bold-search', 'team-room'])).toMatchObject({ jobs: [] })
  await waitFor(() => expect(result.current.team.data?.jobs).toEqual([]))

  act(() =>
    emit({
      seq: 3,
      ts: '2026-10-24T10:02:00.000Z',
      type: 'job.deleted',
      data: { id: directJob.id, roomId: 'direct-lead' },
    }),
  )
  await waitFor(() => expect(result.current.directs.data).toEqual([{ agentId: 'lead', chats: [] }]))
})
