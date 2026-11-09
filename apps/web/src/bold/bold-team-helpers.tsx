import type { AgentDetail } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, vi } from 'vitest'
import { App, appRoutes } from '../App.tsx'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamClient } from '../data/stream.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../data/resync.ts'
import {
  agentResponse,
  builder,
  coder,
  coderDetail,
  codingRuntimes,
  completedOperation,
  dockerRunsOn,
  emptyFor,
  localRunsOn,
  now,
} from './bold-team-fixtures.ts'

class Source extends EventTarget {
  close() {}
}

type Reply = () => Response

export const teamState = {
  agentsReply: (() => Response.json({})) as Reply,
  runsOn: localRunsOn as Record<string, unknown>,
  runsOnPuts: [] as unknown[],
  detailReply: (() => Response.json({})) as Reply,
  watchReply: (() => Response.json({})) as Reply,
  subagentSetupReply: (() => Response.json({})) as Reply,
  pauseReply: null as (() => Response) | null,
  previewReply: (() => Response.json({})) as Reply,
  createReply: (() => Response.json({})) as Reply,
  runsOnReply: null as (() => Response) | null,
  previewHold: null as Promise<void> | null,
  runtimeCalls: 0,
}

export const disposers: (() => void)[] = []

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  teamState.agentsReply = () =>
    Response.json({
      asOfSeq: 1,
      items: [builder, coderDetail, { ...builder, id: 'lead', name: 'lead', reportsTo: null }],
    })
  teamState.runsOn = localRunsOn
  teamState.runsOnPuts = []
  teamState.detailReply = () => agentResponse(builder)
  teamState.subagentSetupReply = () => Response.json({ agents: [] })
  teamState.pauseReply = null
  teamState.createReply = completedOperation
  teamState.runsOnReply = null
  teamState.previewHold = null
  teamState.runtimeCalls = 0
  teamState.previewReply = () =>
    Response.json({
      kind: 'create',
      targetName: 'researcher',
      hash: 'a'.repeat(64),
      inherited: {
        memories: ['Release notes go through reviewer first.'],
        skills: ['Planning'],
        plugins: [],
        approvalSettings: [],
        credentialsPresent: [],
      },
      effects: ['Create profile researcher', 'Install Score’s plugin'],
      blockers: [],
      pendingWork: {
        activeRuns: 0,
        queuedTurns: 0,
        pendingApprovals: 0,
        assignments: 0,
        disposition: '',
      },
      exportPath: null,
    })
  teamState.watchReply = () =>
    Response.json({
      items: [
        {
          agent: builder,
          thumbnail: null,
          status: 'Adding feed pagination',
          live: true,
          surface: 'editor',
        },
      ],
    })
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      if (url.pathname === '/api/agents' && init?.method === 'POST')
        return Promise.resolve(teamState.createReply())
      if (url.pathname === '/api/agents') return Promise.resolve(teamState.agentsReply())
      if (url.pathname.startsWith('/api/agents/operations/'))
        return Promise.resolve(teamState.createReply())
      if (url.pathname === '/api/agents/runs-agent/runs-on' && init?.method === 'PUT')
        return Promise.resolve(teamState.runsOnReply?.() ?? Response.json(dockerRunsOn))
      if (url.pathname === '/api/agents/builder/runs-on') {
        if (init?.method === 'PUT') {
          teamState.runsOnPuts.push(JSON.parse(String(init.body)))
          teamState.runsOn = { ...teamState.runsOn, ...dockerRunsOn }
        }
        return Promise.resolve(Response.json(teamState.runsOn))
      }
      if (
        teamState.pauseReply &&
        (url.pathname === '/api/agents/builder/pause' ||
          url.pathname === '/api/agents/builder/resume')
      )
        return Promise.resolve(teamState.pauseReply())
      if (url.pathname === '/api/watch/overview') return Promise.resolve(teamState.watchReply())
      if (url.pathname === '/api/now') return Promise.resolve(Response.json(now()))
      if (url.pathname === '/api/subagent-setup')
        return Promise.resolve(teamState.subagentSetupReply())
      if (url.pathname === '/api/agents/builder') return Promise.resolve(teamState.detailReply())
      if (url.pathname === '/api/settings/rules')
        return Promise.resolve(
          Response.json({ mode: 'smart', goAhead: [], askMe: [], never: [], drift: [] }),
        )
      if (url.pathname.startsWith('/api/agents/builder/permissions/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop() ?? '')
        return Promise.resolve(
          Response.json({ id, label: 'Permission', level: 'allowed', inherited: false }),
        )
      }
      if (url.pathname === '/api/agents/builder/files/SOUL.md')
        return Promise.resolve(
          Response.json({ content: 'I build small changes.', etag: 'a'.repeat(64) }),
        )
      if (url.pathname === '/api/agents/builder/files/AGENTS.md')
        return Promise.resolve(Response.json({ content: 'Run the tests.', etag: 'b'.repeat(64) }))
      if (url.pathname === '/api/agents/coder') return Promise.resolve(agentResponse(coderDetail))
      if (url.pathname === '/api/coding-agents')
        return Promise.resolve(Response.json({ items: [coder] }))
      if (url.pathname === '/api/coding-agents/backend')
        return Promise.resolve(
          Response.json({
            kind: 'unit',
            note: 'Runs as a supervised service.',
            checks: [],
            checkedAt: '2026-10-24T10:00:00.000Z',
          }),
        )
      if (url.pathname === '/api/agents/coder/workspace')
        return Promise.resolve(
          Response.json({ root: null, available: false, reason: 'No workspace yet.' }),
        )
      if (url.pathname === '/api/agents/coder/quota')
        return Promise.resolve(Response.json({ quota: null }))
      if (url.pathname === '/api/agents/preview')
        return teamState.previewHold
          ? teamState.previewHold.then(() => teamState.previewReply())
          : Promise.resolve(teamState.previewReply())
      if (url.pathname === '/api/coding-agents/runtimes') {
        teamState.runtimeCalls += 1
        return Promise.resolve(Response.json({ items: codingRuntimes }))
      }
      if (url.pathname === '/api/coding-agents/runtimes/claude-code/models')
        return Promise.resolve(Response.json({ models: [], source: 'aliases' }))
      if (url.pathname === '/api/coding-agents/runtimes/codex/models')
        return Promise.resolve(Response.json({ models: [], source: 'aliases' }))
      if (url.pathname === '/api/coding-agents/runtimes/antigravity/models')
        return Promise.resolve(Response.json({ models: [], source: 'aliases' }))
      return Promise.resolve(emptyFor(url.pathname))
    }),
  )
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

export function open(path: string) {
  const queryClient = createQueryClient()
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
  return { router, queryClient }
}

export type LifeState = 'setting_up' | 'ready' | 'deleting' | 'needs_attention' | 'removed'
export function withLifecycle(state: LifeState, status?: 'paused') {
  const lifecycle = {
    state,
    incarnationId: '22222222-2222-4222-8222-222222222222',
    operationId: '11111111-1111-4111-8111-111111111111',
  }
  const agent = { ...builder, lifecycle, ...(status ? { status } : {}) }
  teamState.agentsReply = () => Response.json({ asOfSeq: 1, items: [agent] })
  teamState.detailReply = () => agentResponse(agent as AgentDetail)
  teamState.createReply = () =>
    Response.json({
      ...JSON.parse(JSON.stringify({ id: lifecycle.operationId })),
      kind: state === 'deleting' ? 'delete' : 'create',
      targetName: 'builder',
      incarnationId: lifecycle.incarnationId,
      requestHash: 'a'.repeat(64),
      state: state === 'needs_attention' ? 'needs_attention' : 'running',
      steps: [{ name: 'model', state: 'pending' }],
      createdAt: '2026-10-24T10:00:00.000Z',
      updatedAt: '2026-10-24T10:00:01.000Z',
      nextStep: 'model',
      error: state === 'needs_attention' ? 'The model could not be set.' : null,
      exportPath: null,
      retryable: state === 'needs_attention',
    })
}

export const deleteOp = (state: 'running' | 'completed') => ({
  id: '33333333-3333-4333-8333-333333333333',
  kind: 'delete',
  targetName: 'builder',
  incarnationId: '22222222-2222-4222-8222-222222222222',
  requestHash: 'a'.repeat(64),
  state,
  steps: [{ name: 'delete_profile', state: state === 'completed' ? 'completed' : 'running' }],
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:00:01.000Z',
  nextStep: null,
  error: null,
  exportPath: null,
})

export function deletePreview(blockers: string[] = []) {
  return {
    kind: 'delete',
    targetName: 'builder',
    hash: 'b'.repeat(64),
    inherited: {
      memories: [],
      skills: [],
      plugins: [],
      approvalSettings: [],
      credentialsPresent: [],
    },
    effects: [],
    blockers,
    pendingWork: {
      activeRuns: 1,
      queuedTurns: 2,
      pendingApprovals: 3,
      assignments: 4,
      disposition: 'Its unfinished work goes back to the lead.',
    },
    exportPath: '/home/user/.score/exports/builder.tar',
  }
}

export type Call = { url: string; method: string; body: unknown; headers: Record<string, string> }
/** Wraps the stubbed fetch so the delete endpoints answer with `reply`, and records those calls. */
export function stubDelete(reply: (call: Call) => Response | null) {
  const inner = globalThis.fetch
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      const method = init?.method ?? 'GET'
      const call: Call = {
        url: url.pathname,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      }
      const isDelete =
        (method === 'DELETE' &&
          (url.pathname === '/api/agents/builder' ||
            url.pathname === '/api/coding-agents/coder')) ||
        url.pathname.startsWith('/api/agents/operations/') ||
        url.pathname === '/api/agents/preview' ||
        url.pathname.endsWith('/stop-work')
      if (isDelete) {
        calls.push(call)
        const response = reply(call)
        if (response) return Promise.resolve(response)
      }
      return inner(input, init)
    }),
  )
  return calls
}
