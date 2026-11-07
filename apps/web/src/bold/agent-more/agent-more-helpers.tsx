import { AgentDetailSchema, type AgentDetail } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'

export const agent: AgentDetail = AgentDetailSchema.parse({
  id: 'builder',
  name: 'builder',
  role: 'Builds features',
  style: { color: '#19C39A', shape: 'triangle' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
  tagline: '',
  personality: { excerpt: '', source: 'SOUL.md' },
  reportsTo: null,
  worksIn: null,
  rulesFile: null,
  skills: [],
  memory: [],
  tools: [
    { id: 'terminal', label: 'Terminal', kind: 'builtin', enabled: true },
    { id: 'files', label: 'Files', kind: 'builtin', enabled: false },
    { id: 'search', label: 'Search server', kind: 'mcp', enabled: true },
  ],
  helpersMax: 3,
  routines: [],
  channels: [],
  permissions: [
    { id: 'never:rm -rf *', label: 'rm -rf *', level: 'never', inherited: false },
    { id: 'never:sudo *', label: 'sudo *', level: 'never', inherited: true },
  ],
})

export const at = '2026-10-24T10:00:00.000Z'
export type Call = { method: string; path: string; body: unknown }
export type Memory = { id: string; text: string; source: string; at: string }
export type Override = (path: string, method: string, body: unknown) => Response | null
export type AgentMoreTestWiring = {
  calls: () => Call[]
  override: () => Override | null
  memory: () => Memory[]
  setMemory: (memory: Memory[]) => void
  reset: () => void
}

export const initialMemory = (): Memory[] => [
  { id: 'm1', text: 'Prefers small commits', source: 'you', at },
]

const disposers: (() => void)[] = []

class Source extends EventTarget {
  close() {}
}

function reply(path: string, method: string, body: unknown, wiring: AgentMoreTestWiring): Response {
  const forced = wiring.override()?.(path, method, body)
  if (forced) return forced
  if (method !== 'GET') {
    if (path.endsWith('/memory') && method === 'POST') {
      const memory = [
        ...wiring.memory(),
        { id: 'm2', text: (body as { text: string }).text, source: 'you', at },
      ]
      wiring.setMemory(memory)
      return Response.json(memory[memory.length - 1])
    }
    if (path.includes('/memory/')) {
      wiring.setMemory([])
      return new Response(null, { status: 204 })
    }
    if (path.includes('/skills/')) return Response.json({})
    if (path.includes('/tools/'))
      return Response.json({ id: 'files', label: 'Files', kind: 'builtin', enabled: true })
    if (path.endsWith('/run')) return new Response(null, { status: 204 })
    if (path.includes('/settings/plugins/'))
      return Response.json({
        id: 'extra',
        label: 'Extra',
        enabled: true,
        locked: false,
        description: null,
      })
    if (path.includes('/permissions/'))
      return Response.json({ id: 'x', label: 'x', level: 'never', inherited: false })
    if (path.endsWith('/mcp'))
      return Response.json({ ...mcp, enabled: (body as { enabled?: boolean }).enabled ?? false })
    if (path === '/api/agents/builder') return Response.json({ ...agent, ...(body as object) })
    return new Response(null, { status: 204 })
  }
  if (path.endsWith('/memory')) return Response.json({ items: wiring.memory(), nextCursor: null })
  if (path.endsWith('/skills'))
    return Response.json({
      items: [
        { name: 'planning', enabled: true },
        { name: 'sketching', enabled: false },
      ],
    })
  if (path.endsWith('/skills/hub'))
    return Response.json({
      items: [
        {
          name: 'writer',
          identifier: 'hub/writer',
          source: 'hub',
          trust: 'x',
          description: 'Writes',
        },
      ],
    })
  if (path.endsWith('/knowledge')) return Response.json({ enabled: false })
  if (path.endsWith('/routines'))
    return Response.json({
      items: [
        {
          id: 'r1',
          title: 'Nightly tests',
          schedule: '0 2 * * *',
          description: '',
          lastRunAt: null,
          enabled: true,
        },
      ],
    })
  if (path.endsWith('/settings/plugins'))
    return Response.json({
      items: [
        { id: 'extra', label: 'Extra', enabled: false, locked: false, description: null },
        { id: 'score', label: 'Score bridge', enabled: true, locked: true, description: null },
      ],
    })
  if (path.endsWith('/channels'))
    return Response.json({
      items: [
        {
          platform: 'telegram',
          label: 'Telegram',
          status: 'disconnected',
          detail: 'no_token',
          connectCommand: 'hermes gateway setup',
        },
        {
          platform: 'slack',
          label: 'Slack',
          status: 'connected',
          detail: null,
          connectCommand: 'x',
        },
      ],
    })
  if (path.endsWith('/history'))
    return Response.json({
      items: [
        {
          runId: 'run-1',
          title: 'Fix the feed',
          origin: 'score',
          outcome: 'completed',
          startedAt: at,
          durationSec: 60,
          model: null,
          costUsd: null,
          task: null,
          brief: null,
          replaySeq: 7,
        },
      ],
      nextCursor: null,
    })
  if (path.endsWith('/todos'))
    return Response.json({
      todos: [{ id: 't1', content: 'Write tests', status: 'pending' }],
      revision: 1,
      updatedAt: at,
    })
  if (path.endsWith('/mcp')) return Response.json(mcp)
  if (path.endsWith('/workspace'))
    return Response.json({ root: '/srv/app', available: true, reason: null })
  if (path.endsWith('/workspace/git'))
    return Response.json({ branch: 'main', changed: 2, ahead: 0, behind: 0 })
  if (path.endsWith('/workspace/tree'))
    return Response.json({
      entries: [
        {
          name: 'old.txt',
          kind: 'file',
          size: 1,
          mtime: '2026-01-01T00:00:00.000Z',
          hidden: false,
        },
        {
          name: 'events.py',
          kind: 'file',
          size: 1,
          mtime: '2026-10-01T00:00:00.000Z',
          hidden: false,
        },
        { name: 'src', kind: 'dir', size: 0, mtime: '2026-10-02T00:00:00.000Z', hidden: false },
      ],
    })
  return Response.json({ items: [] })
}

export const mcp = {
  agentId: 'builder',
  enabled: false,
  writesEnabled: false,
  hasToken: false,
  tokenCreatedAt: null,
  available: true,
  url: 'http://x',
  command: 'hermes mcp add score',
  postsThisHour: 0,
  postLimitPerHour: 30,
}

export const token = `scm_${'a'.repeat(43)}`

export function setUpAgentMoreTests(wiring: AgentMoreTestWiring) {
  beforeEach(() => {
    wiring.reset()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://x')
        const method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        // Tree and git requests carry a query; the pathname decides.
        if (method !== 'GET' || !/\/workspace\/(git|tree)$|\/workspace$/.test(url.pathname))
          wiring.calls().push({ method, path: url.pathname, body })
        return Promise.resolve(reply(url.pathname.replace(/^\/api/, '/api'), method, body, wiring))
      }),
    )
  })

  afterEach(() => {
    cleanup()
    disposers.splice(0).forEach((dispose) => dispose())
    vi.unstubAllGlobals()
  })

  function mount(ui: ReactNode) {
    const queryClient = createQueryClient()
    const client = createStreamClient({ EventSourceImpl: Source as never })
    const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
    disposers.push(() => {
      queries.dispose()
      client.close()
      queryClient.clear()
    })
    render(
      <QueryClientProvider client={queryClient}>
        <StreamContext value={{ client, queries }}>
          <MemoryRouter>{ui}</MemoryRouter>
        </StreamContext>
      </QueryClientProvider>,
    )
  }

  const sent = (method: string, suffix: string) =>
    wiring.calls().find((call) => call.method === method && call.path.endsWith(suffix))

  return { mount, sent }
}
