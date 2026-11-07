import type { AgentSummary } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, vi } from 'vitest'
import { App, appRoutes } from '../App.tsx'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { immediateFrameScheduler, createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { jsonResponse, reportFixture } from '../test/reports-fixtures.ts'

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
    activity: 'Adding feed pagination',
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
  {
    id: 'reviewer',
    name: 'reviewer',
    role: 'Reviews changes',
    style: { color: '#FFB61E', shape: 'diamond' },
    status: 'waiting',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
  {
    id: 'designer',
    name: 'designer',
    role: 'Designs interfaces',
    style: { color: '#FF6B8A', shape: 'square' },
    status: 'idle',
    activity: null,
    model: { id: 'fake-model', label: 'Demo model' },
    served: true,
  },
]

vi.mock('../notifications/NotificationBridge.tsx', () => ({
  NotificationBridge: () => <span data-testid="notification-bridge" />,
}))
vi.mock('../pwa/UpdateBanner.tsx', () => ({
  UpdateBanner: () => <span data-testid="update-banner" />,
}))

class Source extends EventTarget {
  close() {}
}

export const shellState: {
  phone: boolean
  narrow: boolean
  approvalFixture: boolean
  terminalFixture: { terminal: boolean; terminalUnavailable: string | null } | null
  extraAgents: AgentSummary[]
  teamRoomFixture: unknown
  runJobs: unknown[]
  runSummaries: unknown[]
  resultsFixture: unknown
  workbenchFixture: unknown
} = {
  phone: false,
  narrow: false,
  approvalFixture: false,
  terminalFixture: null,
  extraAgents: [],
  teamRoomFixture: null,
  runJobs: [],
  runSummaries: [],
  resultsFixture: { asOfSeq: 1, items: [], screens: [] },
  workbenchFixture: null,
}

export const disposers: (() => void)[] = []

beforeEach(() => {
  shellState.phone = false
  shellState.narrow = false
  shellState.approvalFixture = false
  shellState.terminalFixture = null
  shellState.extraAgents = []
  shellState.teamRoomFixture = null
  shellState.runJobs = []
  shellState.runSummaries = []
  shellState.resultsFixture = { asOfSeq: 1, items: [], screens: [] }
  shellState.workbenchFixture = null
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches:
          query === '(max-width: 860px)'
            ? shellState.phone
            : query === '(max-width: 1279px)'
              ? shellState.narrow
              : false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      url.searchParams.delete('tz')
      if (url.pathname === '/api/session/security' && shellState.terminalFixture)
        return Promise.resolve(
          Response.json({ passwordSet: true, origins: [], ...shellState.terminalFixture }),
        )
      if (url.pathname === '/api/agents')
        return Promise.resolve(
          Response.json({ asOfSeq: 1, items: [...agents, ...shellState.extraAgents] }),
        )
      if (url.pathname === '/api/team-room' && shellState.teamRoomFixture)
        return Promise.resolve(
          Response.json({ asOfSeq: 1, ...(shellState.teamRoomFixture as object) }),
        )
      if (url.pathname === '/api/approvals' && shellState.approvalFixture)
        return Promise.resolve(
          Response.json({
            asOfSeq: 1,
            items: [
              {
                id: 'approval-notes',
                origin: 'score-run',
                phase: 'human_pending',
                status: 'pending',
                actionable: true,
                linkedTo: null,
                agentId: 'builder',
                title: 'May I install a package?',
                command: 'npm install ws@8',
                cwd: '~/app',
                description: 'The notes job needs ws.',
                choices: ['once', 'deny'],
                createdAt: '2026-10-24T09:03:00.000Z',
                expiresAt: null,
                decision: null,
                delivery: 'none',
                blocking: null,
                refs: [],
              },
            ],
            nextCursor: null,
          }),
        )
      if (url.pathname === '/api/knowledge')
        return Promise.resolve(
          Response.json({
            vault: '/vault',
            notes: 1,
            gitAvailable: true,
            agentAccess: true,
            memoryNotes: true,
            documents: 0,
            documentBytes: 0,
            moveIssue: null,
          }),
        )
      if (url.pathname === '/api/knowledge/tree')
        return Promise.resolve(
          Response.json({
            folders: ['Decisions'],
            notes: [
              {
                path: 'Decisions/Source.md',
                title: 'Source',
                mtime: '2026-10-24T09:00:00.000Z',
                lastAuthor: 'you',
              },
            ],
            documents: [],
          }),
        )
      if (url.pathname === '/api/knowledge/notes/Decisions/Source.md')
        return Promise.resolve(
          Response.json({
            path: 'Decisions/Source.md',
            title: 'Source',
            frontmatter: {},
            body: '# Source\n\nThe source of truth.\n',
            etag: 'etag-source',
            mtime: '2026-10-24T09:00:00.000Z',
            links: [],
            backlinks: [],
            lastAuthor: 'you',
            versioned: true,
            history: 'unchanged',
          }),
        )
      if (/^\/api\/jobs\/[^/]+\/results$/.test(url.pathname))
        return Promise.resolve(Response.json(shellState.resultsFixture))
      if (/^\/api\/jobs\/[^/]+\/workbench$/.test(url.pathname) && shellState.workbenchFixture)
        return Promise.resolve(Response.json(shellState.workbenchFixture))
      if (url.pathname === '/api/team-rooms' && shellState.runJobs.length > 0)
        return Promise.resolve(
          Response.json({
            asOfSeq: 1,
            items: [
              {
                id: 'team-room',
                name: 'Team room',
                kind: 'room',
                leadAgentId: 'lead',
                members: agents.map((agent) => agent.id),
                unread: 0,
                activeAgents: [],
                channels: [],
                role: 'team',
                routing: 'exchanges',
              },
            ],
          }),
        )
      if (url.pathname === '/api/rooms/team-room/messages' && shellState.runJobs.length > 0)
        return Promise.resolve(
          Response.json({ asOfSeq: 1, items: [], nextCursor: null, jobId: null }),
        )
      if (url.pathname === '/api/rooms/team-room/jobs' && shellState.runJobs.length > 0)
        return Promise.resolve(
          Response.json({ asOfSeq: 1, items: shellState.runJobs, nextCursor: null }),
        )
      if (url.pathname === '/api/orchestrations')
        return Promise.resolve(Response.json({ asOfSeq: 1, items: shellState.runSummaries }))
      if (url.pathname === '/api/workflow-runs')
        return Promise.resolve(Response.json({ asOfSeq: 1, items: [] }))
      if (url.pathname === '/api/orchestrations/fence')
        return Promise.resolve(
          Response.json({
            fenced: false,
            reason: null,
            untrustedHistory: false,
            revision: 1,
            since: null,
            items: [],
            journal: { ok: true, entries: 0, bytes: 0, sizeAlarm: false },
          }),
        )
      if (url.pathname === '/api/rooms/team-room/messages' && shellState.approvalFixture)
        return Promise.resolve(
          Response.json({
            asOfSeq: 1,
            items: [
              {
                id: 'approval:approval-notes',
                roomId: 'team-room',
                jobId: 'job-notes',
                author: { kind: 'agent', agentId: 'builder' },
                to: [],
                parts: [{ kind: 'approval', approvalId: 'approval-notes' }],
                createdAt: '2026-10-24T09:03:00.000Z',
                streaming: false,
                refs: [],
              },
            ],
            nextCursor: null,
            jobId: 'job-notes',
          }),
        )
      if (url.pathname === '/api/watch/overview')
        return Promise.resolve(
          Response.json({
            items: agents.map((agent) => ({
              agent,
              thumbnail: null,
              status: 'Idle',
              live: false,
              surface: null,
            })),
          }),
        )
      if (url.pathname === '/api/now')
        return Promise.resolve(
          Response.json({
            asOfSeq: 1,
            now: new Date().toISOString(),
            paused: false,
            headline: { working: 1, needsYou: 0, text: 'One agent is working.' },
            lanes: [],
            handoffs: [],
            focusApproval: null,
            thread: null,
            madeToday: [],
          }),
        )
      if (url.pathname === '/api/reports')
        return Promise.resolve(
          jsonResponse(
            reportFixture((url.searchParams.get('range') as 'today' | '7d' | '30d' | null) ?? '7d'),
          ),
        )
      return Promise.resolve(
        Response.json(
          {
            asOfSeq: 0,
            items: [],
            rooms: [],
            directs: [],
            projects: [],
            columns: { planned: [], working: [], in_review: [], needs_you: [], done: [] },
          },
          { status: 200 },
        ),
      )
    }),
  )
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

function open(
  path: string,
  teamJobs: {
    id: string
    title: string
    state: 'working' | 'waiting_on_you'
    isDefault: boolean
    recipe?: { kind: 'orchestration' | 'workflow'; ref: string }
  }[] = [],
) {
  const queryClient = createQueryClient()
  // The shell reads the team room before deciding between first run and the room. These frame tests start with that
  // read already cached, as it is on a normal navigation inside the app; the first-run spec covers the cold read.
  const teamRoom = {
    room: {
      id: 'team-room',
      name: 'Team room',
      kind: 'room',
      leadAgentId: 'lead',
      members: agents.map((agent) => agent.id),
      unread: 0,
      activeAgents: [],
      channels: [],
      role: 'team',
      routing: 'exchanges',
    },
    jobs: teamJobs.map((job) => ({
      roomId: 'team-room',
      holderAgentId: 'lead',
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
      ...job,
    })),
  }
  if (shellState.approvalFixture || shellState.runJobs.length > 0)
    shellState.teamRoomFixture = teamRoom
  queryClient.setQueryData(['bold', 'team-room', null], { asOfSeq: 1, data: teamRoom })
  const client = createStreamClient({ EventSourceImpl: Source as never })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  disposers.push(() => {
    router.dispose()
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <App router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
  return router
}

export { open }
