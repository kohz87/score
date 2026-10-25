import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../../data/resync.ts'
import type { StreamClient } from '../../data/stream.ts'
import { useRoomNeedsYouState } from './use-needs-you.ts'

function Probe({ selectedJob }: { selectedJob: string }) {
  const state = useRoomNeedsYouState({ roomId: null, jobs: [], selectedJob })
  return <span>{`${state.ready}:${state.total}`}</span>
}

function mount(selectedJob = 'all') {
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({ queries: { retry: false } })
  const stream = {
    subscribe: () => () => undefined,
    onControl: () => () => undefined,
  } as unknown as StreamClient
  const queries = createStreamQueryRegistry(queryClient, stream, immediateFrameScheduler)
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client: stream, queries }}>
        <Probe selectedJob={selectedJob} />
      </StreamContext>
    </QueryClientProvider>,
  )
  return { ...rendered, queryClient, queries }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('waits for the team room and counts the selected job', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://x').pathname
      if (path === '/api/team-room')
        return Response.json({
          asOfSeq: 1,
          room: {
            id: 'team-room',
            name: 'Team room',
            kind: 'room',
            leadAgentId: 'lead',
            members: [],
            unread: 0,
            activeAgents: [],
            channels: [],
            role: 'team',
            routing: 'exchanges',
          },
          jobs: [
            {
              id: 'job-notes',
              roomId: 'team-room',
              title: 'Release notes',
              state: 'waiting_on_you',
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
              createdAt: '2026-10-24T09:00:00.000Z',
              updatedAt: '2026-10-24T09:00:00.000Z',
            },
          ],
        })
      if (path === '/api/approvals')
        return Response.json({ asOfSeq: 1, items: [], nextCursor: null })
      if (path === '/api/jobs/job-notes/exchanges') return Response.json({ asOfSeq: 1, items: [] })
      if (path === '/api/orchestrations') return Response.json({ asOfSeq: 1, items: [] })
      if (path === '/api/workflow-runs') return Response.json({ asOfSeq: 1, items: [] })
      return Response.json({ asOfSeq: 1, items: [] })
    }),
  )
  const mounted = mount('job-notes')
  await waitFor(() => expect(screen.getByText(/^true:/)).toBeDefined())
  expect(screen.getByText('true:0')).toBeDefined()
  mounted.queries.dispose()
  mounted.queryClient.clear()
})
