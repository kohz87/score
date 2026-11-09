import { ORCH_ACKNOWLEDGEMENT_TEXT, type AgentSummary } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { expect, vi } from 'vitest'
import { App, appRoutes } from '../App.tsx'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { immediateFrameScheduler, createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { BoldStartJob, type StartJobOptions } from './BoldStartJob.tsx'

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

export const iso = '2026-10-24T09:00:00.000Z'
export const room = {
  id: 'team-room',
  name: 'Team room',
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder', 'reviewer', 'designer'],
  unread: 0,
  activeAgents: [],
  channels: [],
  role: 'team',
  routing: 'exchanges',
}
const definition = {
  name: 'Release recipe',
  description: 'Writes the notes.',
  inputs: [{ name: 'topic', label: 'Topic', required: true, maxChars: 200 }],
  nodes: [
    {
      id: 'work',
      kind: 'agent',
      label: 'Write the notes',
      agentId: 'builder',
      instruction: 'Write the notes about {{inputs.topic}}.',
      retries: 0,
      onFailure: 'fail_run',
    },
    { id: 'done', kind: 'end', label: 'Done' },
  ],
  edges: [{ id: 'work_done', from: 'work', port: 'ok', to: 'done' }],
}
const version = {
  version: 1,
  hash: 'a'.repeat(64),
  createdAt: iso,
  used: false,
  bytes: 640,
  nodes: 2,
  maxSteps: 1,
}
export const workflow = {
  id: 'wf_release',
  name: 'Release recipe',
  description: 'Writes the notes.',
  latestVersion: 1,
  versionCount: 1,
  used: false,
  agentIds: ['builder'],
  createdAt: iso,
  updatedAt: iso,
  activeRuns: 0,
  archivedAt: null as string | null,
}
const routine = {
  id: 'lead:nightly',
  title: 'Nightly build check',
  schedule: 'Every weekday at 9:00',
  description: 'Check the build.',
  lastRunAt: null,
  enabled: true,
}
export const workflowPreflight = {
  ok: true,
  checks: [
    { id: 'definition', status: 'ok', message: 'The graph is valid' },
    { id: 'agents', status: 'ok', message: 'builder is ready' },
    { id: 'mapping', status: 'ok', message: 'Every agent is mapped' },
  ],
  issues: [],
  mapping: [{ agentId: 'builder', name: 'builder', incarnation: 'inc-1' }],
  gatePolicyNotes: { 'gates-only': 'Gates ask you.', 'every-step': 'Every step asks you.' },
  acknowledgementText: ORCH_ACKNOWLEDGEMENT_TEXT,
  spendNote: 'Costs are settled when the run ends.',
  maxSteps: 1,
  reserveBytes: 0,
  workers: [],
  defaults: { gatePolicy: 'gates-only', maxConcurrentSteps: 2, stepEstimateUsd: 0.5 },
}
const orchestrationCheck = (ok: boolean) => ({
  ok,
  checks: [
    {
      id: 'allowed_agents',
      status: ok ? 'ok' : 'fail',
      message: ok ? 'All step agents are ready' : 'Hermes is not reachable',
    },
  ],
  workers: [],
  gatePolicyNotes: {
    'every-step': 'You approve every assignment.',
    'lead-asks': 'The lead asks when it needs to.',
    none: 'Assignments start without approval.',
  },
  acknowledgementText: ORCH_ACKNOWLEDGEMENT_TEXT,
  defaults: {
    maxSteps: 12,
    maxLeadTurns: 20,
    maxConcurrentSteps: 2,
    leadTurnEstimateUsd: 0.25,
    stepEstimateUsd: 0.5,
    codingSteps: 10,
  },
  reserveBytes: 0,
})
const triggerCreated = {
  trigger: {
    id: 'trg_unit',
    name: 'New lead',
    app: 'Tickets',
    mapping: { ref: 'ref' },
    template: 'Write the release notes',
    reportBack: { mode: 'off' },
    url: 'https://score.test/hooks/trg_unit',
    sample: null,
    lastCalledAt: null,
    createdAt: iso,
  },
  secret: 'whsec_unit_secret',
}

class Source extends EventTarget {
  close() {}
}

export const startJobState = {
  preflightFails: false,
  /** 3.13.2: the preflight itself refused (a full-access coding agent). */
  preflightRefusal: null as { code: string; message: string } | null,
  /** 3.7.9: the lead's tool list; after a reload the next preflight reports it ok. */
  toolsListed: null as 'unknown' | 'ok' | null,
  reloads: [] as string[],
  /** 3.7.5: a coding agent leading the room (null: the fixture's `lead`). */
  codingLead: null as string | null,
  workflowPreflightNow: workflowPreflight as unknown,
  workflowRunBodies: [] as Record<string, unknown>[],
  workflowRunReply: (() =>
    Response.json(
      { error: { code: 'internal', message: 'no' } },
      { status: 500 },
    )) as () => Response,
  triggerBody: undefined as unknown,
  /** 3.13: calls the oracle tests watch, in order, and what the orchestration POST answers. */
  calls: [] as string[],
  orchestrationBodies: [] as Record<string, unknown>[],
  lastOrchestrationPreflight: null as unknown,
  preflightUrls: [] as string[],
  roomJobPosts: [] as Record<string, unknown>[],
  orchestrationReply: (() =>
    Response.json(
      { error: { code: 'internal', message: 'no' } },
      { status: 500 },
    )) as () => Response,
  securityReply: (() => Response.json({ ok: true })) as () => Response,
  extraWorkflows: [] as (typeof workflow)[],
  /** 3.28.0: the team room's jobs the read answers with, and what Stop job (`/end`) answers. */
  teamJobs: [] as Record<string, unknown>[],
  endReply: (() => Response.json({}, { status: 500 })) as () => Response,
  disposers: [] as (() => void)[],
  subagentControl: 'limits' as 'limits' | 'on_off' | 'none' | 'error', // SA.3: `error` = unreadable
  subagentMax: 4,
}

export function beginStartJobTest() {
  const state = startJobState
  state.preflightFails = false
  state.preflightRefusal = null
  state.workflowPreflightNow = workflowPreflight
  state.workflowRunBodies = []
  state.workflowRunReply = () =>
    Response.json({ error: { code: 'internal', message: 'no' } }, { status: 500 })
  state.triggerBody = undefined
  state.calls = []
  state.orchestrationBodies = []
  state.preflightUrls = []
  state.roomJobPosts = []
  state.extraWorkflows = []
  state.teamJobs = []
  state.endReply = () => Response.json({}, { status: 500 })
  state.codingLead = null
  state.subagentControl = 'limits'
  state.subagentMax = 4
  state.securityReply = () => Response.json({ ok: true })
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
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      url.searchParams.delete('tz')
      const method = init?.method ?? 'GET'
      const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }))

      if (url.pathname === '/api/agents')
        return json({
          asOfSeq: 1,
          items: state.codingLead
            ? [
                ...agents,
                { ...agents[1]!, id: state.codingLead, name: state.codingLead, runtime: 'codex' },
              ]
            : agents,
        })
      if (url.pathname === '/api/approvals') return json({ asOfSeq: 1, items: [] })
      if (url.pathname === '/api/rooms')
        return json({
          asOfSeq: 1,
          rooms: [{ ...room, id: 'design-crew', name: 'Design crew', role: 'room' }],
          directs: [],
          projects: [],
        })
      if (url.pathname === '/api/team-room')
        return json({
          asOfSeq: 1,
          room: { ...room, leadAgentId: state.codingLead ?? room.leadAgentId },
          jobs: [],
        })
      if (url.pathname === '/api/workflows')
        return json({
          items: [workflow, ...state.extraWorkflows],
          inventory: {
            definitions: 1,
            versions: 1,
            bytes: 640,
            maxDefinitions: 200,
            maxVersionsPerDefinition: 20,
          },
        })
      if (url.pathname === '/api/workflows/wf_release')
        return json({
          ...workflow,
          versions: [version],
          latest: { ...version, workflowId: 'wf_release', definition },
        })
      if (url.pathname === '/api/workflow-runs/preflight') return json(state.workflowPreflightNow)
      if (url.pathname === '/api/workflow-runs' && method === 'POST') {
        state.workflowRunBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Promise.resolve(state.workflowRunReply())
      }
      if (url.pathname === '/api/orchestrations/preflight') {
        state.preflightUrls.push(url.searchParams.get('allowedAgents') ?? '')
        if (state.preflightRefusal)
          return Promise.resolve(Response.json({ error: state.preflightRefusal }, { status: 422 }))
        const check = orchestrationCheck(!state.preflightFails)
        state.lastOrchestrationPreflight = check
        if (state.toolsListed)
          check.checks.push({
            id: 'tool_readiness',
            status: state.toolsListed,
            message:
              state.toolsListed === 'ok'
                ? 'The lead sees every orch.* tool'
                : "The lead's Hermes hasn't asked Score for its tools",
          })
        return json(check)
      }
      if (url.pathname === '/api/session/security/check' && method === 'POST') {
        state.calls.push('security-check')
        return Promise.resolve(state.securityReply())
      }
      if (url.pathname === '/api/orchestrations' && method === 'POST') {
        state.calls.push('orchestrations')
        state.orchestrationBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Promise.resolve(state.orchestrationReply())
      }
      if (url.pathname === '/api/agents/lead/mcp/reload' && method === 'POST') {
        state.reloads.push('lead')
        state.toolsListed = 'ok'
        return json({ agentId: 'lead', scope: 'profile' })
      }
      if (/^\/api\/agents\/[^/]+\/subagents$/.test(url.pathname))
        return state.subagentControl === 'error'
          ? json({ error: { code: 'internal', message: 'no' } }, 500)
          : json({
              agentId: url.pathname.split('/')[3],
              control: state.subagentControl,
              enabled: true,
              maxConcurrent: state.subagentMax,
              model: null,
              maxIterations: 50,
              timeoutSeconds: null,
            })
      if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/routines'))
        return json({ items: url.pathname.includes('/agents/lead/') ? [routine] : [] })
      if (url.pathname === '/api/rooms/team-room/jobs' && method === 'GET')
        return json({ asOfSeq: 1, items: state.teamJobs })
      if (/^\/api\/jobs\/[^/]+\/end$/.test(url.pathname) && method === 'POST') {
        state.calls.push('job-end')
        return Promise.resolve(state.endReply())
      }
      if (/^\/api\/rooms\/[^/]+\/jobs$/.test(url.pathname) && method === 'POST') {
        state.calls.push('room-job')
        state.roomJobPosts.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return json({ error: { code: 'internal', message: 'no' } }, 500)
      }
      if (url.pathname === '/api/triggers' && method === 'POST') {
        state.triggerBody = JSON.parse(String(init?.body))
        return json(triggerCreated, 201)
      }
      return json({
        asOfSeq: 0,
        items: [],
        rooms: [],
        directs: [],
        projects: [],
        columns: { planned: [], working: [], in_review: [], needs_you: [], done: [] },
      })
    }),
  )
}

export function endStartJobTest() {
  cleanup()
  startJobState.disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
}

export function open(path: string) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source as never })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  startJobState.disposers.push(() => {
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

export function openWith(options: StartJobOptions) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source as never })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  const router = createMemoryRouter(
    [{ path: '/', element: <BoldStartJob onClose={() => {}} options={options} /> }],
    { initialEntries: ['/'] },
  )
  startJobState.disposers.push(() => {
    router.dispose()
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>
        <RouterProvider router={router} />
      </StreamContext>
    </QueryClientProvider>,
  )
}

export async function startDialog() {
  return screen.findByRole('dialog', { name: 'Start a job' })
}

export function acknowledgement(dialog: HTMLElement) {
  return within(dialog).getByRole('checkbox', { name: /Score controls the work it starts/ })
}

export async function recipeDialog() {
  open('/b?start=job&recipe=wf_release')
  const dialog = await startDialog()
  await waitFor(() =>
    expect(within(dialog).getByRole('radio', { name: 'Release recipe' })).toBeDefined(),
  )
  return dialog
}

export async function fillLeadJob(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByLabelText('What should the team do?'), {
    target: { value: 'Fix the failing tests' },
  })
  fireEvent.click(acknowledgement(dialog))
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  return start
}
