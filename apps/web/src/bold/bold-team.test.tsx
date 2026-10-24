import { AgentDetailSchema, type AgentDetail, type CodingAgent } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App, appRoutes } from '../App.tsx'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamClient } from '../data/stream.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../data/resync.ts'

const builder = AgentDetailSchema.parse({
  id: 'builder',
  name: 'builder',
  role: 'Builds features',
  style: { color: '#19C39A', shape: 'triangle' },
  status: 'working',
  activity: 'Adding feed pagination',
  model: { id: 'demo/next-model', label: 'Next model', via: 'Demo', fallback: 'demo/safe' },
  served: true,
  tagline: 'Builds features',
  personality: { excerpt: 'I build small changes.', source: 'SOUL.md' },
  reportsTo: 'lead',
  worksIn: '/srv/app',
  rulesFile: 'AGENTS.md',
  skills: [{ name: 'collaboration', enabled: true }],
  memory: [],
  tools: [{ id: 'terminal', label: 'Terminal & Processes', kind: 'builtin', enabled: true }],
  helpersMax: 3,
  routines: [],
  channels: [],
  permissions: [
    { id: 'install packages', label: 'Installing packages', level: 'asks', inherited: false },
    { id: 'push code', label: 'Pushing code', level: 'asks', inherited: false },
    { id: 'delete files', label: 'Deleting files', level: 'asks', inherited: false },
    {
      id: 'use the screen',
      label: 'Using the mouse and keyboard on its screen',
      level: 'asks',
      inherited: false,
    },
    { id: 'SQL DROP', label: 'SQL DROP', level: 'allowed', inherited: true },
  ],
})

const coderDetail = AgentDetailSchema.parse({
  ...builder,
  id: 'coder',
  name: 'coder',
  role: 'Reviews build scripts',
  style: { color: '#6B4EFF', shape: 'hexagon' },
  status: 'idle',
  activity: null,
  model: null,
  runtime: 'codex',
  runtimeNote: 'Codex · uses your ChatGPT plan quota',
  tagline: '',
  personality: { excerpt: '', source: 'SOUL.md' },
  reportsTo: null,
  worksIn: null,
  rulesFile: null,
  skills: [],
  memory: [],
  tools: [],
  routines: [],
  channels: [],
  permissions: [],
  helpersMax: null,
})

const coder: CodingAgent = {
  id: 'coder',
  name: 'coder',
  role: 'Reviews build scripts',
  instructions: '',
  instructionsEtag: 'etag-1',
  runtime: 'codex',
  workspace: '/home/user/score-workspaces/coder',
  permission: 'workspace-write',
  model: null,
  style: { color: '#6B4EFF', shape: 'hexagon' },
  quota: 'Uses your ChatGPT plan quota.',
  quotaFloorPercent: 10,
  cli: { state: 'ready', version: '0.160.1', testedVersions: ['0.160.1'], confirmed: false },
  heldGroups: [],
  createdAt: '2026-10-16T00:00:00.000Z',
}

class Source extends EventTarget {
  close() {}
}

let agentsReply: () => Response
let detailReply: () => Response
let watchReply: () => Response
let pauseReply: (() => Response) | null
const disposers: (() => void)[] = []

function now() {
  return {
    asOfSeq: 1,
    now: '2026-10-24T10:00:00.000Z',
    paused: false,
    headline: { working: 1, needsYou: 0, text: 'One agent is working.' },
    lanes: [],
    handoffs: [],
    focusApproval: null,
    thread: null,
    madeToday: [],
  }
}

function agentResponse(agent: AgentDetail): Response {
  return Response.json(agent)
}

function emptyFor(pathname: string): Response {
  if (pathname.endsWith('/memory')) return Response.json({ items: [], nextCursor: null })
  if (pathname.endsWith('/skills')) return Response.json({ items: [] })
  if (pathname.endsWith('/todos'))
    return Response.json({ todos: [], revision: 1, updatedAt: '2026-10-24T10:00:00.000Z' })
  if (pathname.endsWith('/routines') || pathname.endsWith('/channels'))
    return Response.json({ items: [] })
  if (pathname.endsWith('/history')) return Response.json({ items: [], nextCursor: null })
  if (pathname.endsWith('/quota')) return Response.json({ quota: null })
  if (pathname.endsWith('/coding-agents')) return Response.json({ items: [] })
  return Response.json({ items: [], nextCursor: null })
}

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
  agentsReply = () => Response.json({ asOfSeq: 1, items: [builder, coderDetail, { ...builder, id: 'lead', name: 'lead', reportsTo: null }] })
  detailReply = () => agentResponse(builder)
  pauseReply = null
  watchReply = () =>
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
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      if (url.pathname === '/api/agents') return Promise.resolve(agentsReply())
      if (
        pauseReply &&
        (url.pathname === '/api/agents/builder/pause' ||
          url.pathname === '/api/agents/builder/resume')
      )
        return Promise.resolve(pauseReply())
      if (url.pathname === '/api/watch/overview') return Promise.resolve(watchReply())
      if (url.pathname === '/api/now') return Promise.resolve(Response.json(now()))
      if (url.pathname === '/api/agents/builder') return Promise.resolve(detailReply())
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
      return Promise.resolve(emptyFor(url.pathname))
    }),
  )
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

function open(path: string) {
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

test('Team cards show state, a Watch glimpse, Message and a way to open the agent', async () => {
  open('/b/team')
  expect(await screen.findByRole('heading', { name: 'Your team' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Pause everyone' })).toBeDefined()

  const card = (await screen.findByRole('link', { name: 'builder' })).closest('article')!
  expect(within(card).getByText('Working · Adding feed pagination')).toBeDefined()
  expect(within(card).getByRole('img', { name: /builder.s screen: editor/ })).toBeDefined()
  expect(within(card).getByRole('link', { name: 'Message' }).getAttribute('href')).toBe(
    '/b?with=builder',
  )
  expect(within(card).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
    '/b/team/builder',
  )

  const coderCard = screen.getByRole('link', { name: 'coder' }).closest('article')!
  expect(within(coderCard).queryByRole('img', { name: /coder.s screen/ })).toBeNull()
  expect(within(coderCard).getByText('Codex')).toBeDefined()
})

test('Team says so when there are no agents and when the list cannot load', async () => {
  agentsReply = () => Response.json({ asOfSeq: 1, items: [] })
  watchReply = () => Response.json({ items: [] })
  open('/b/team')
  expect(await screen.findByText('No agents yet')).toBeDefined()
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())

  agentsReply = () =>
    Response.json({ error: { code: 'unavailable', message: 'no' } }, { status: 500 })
  open('/b/team')
  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Couldn’t load the team')).toBeDefined()
  expect(within(alert).getByRole('button', { name: 'Try again' })).toBeDefined()
})

test('the agent page puts the four cards first and makes every classic tab reachable under More', async () => {
  open('/b/team/builder')
  expect(await screen.findByRole('heading', { name: 'builder', level: 1 })).toBeDefined()
  expect(screen.getByText('How builder works')).toBeDefined()
  expect(await screen.findByRole('textbox', { name: 'SOUL.md contents' })).toBeDefined()
  expect(screen.getByText('Hermes')).toBeDefined()
  expect(screen.getByText('Next model')).toBeDefined()
  expect(screen.getByText(/Falls back to demo\/safe/)).toBeDefined()
  expect(screen.getByText('Comes in 11.8a')).toBeDefined()
  expect(screen.getByText('Asks you first before')).toBeDefined()
  expect(screen.getByText('Installing packages')).toBeDefined()
  expect(screen.getByText('Pushing code')).toBeDefined()
  expect(screen.getByText('Deleting files')).toBeDefined()
  expect(screen.getByText('Using the mouse and keyboard on its screen')).toBeDefined()
  // A rule set to Allowed is not something the agent asks about.
  expect(screen.queryByText('SQL DROP')).toBeNull()
  expect(screen.getByText('Reports to')).toBeDefined()
  expect(screen.getByRole('link', { name: 'lead' }).getAttribute('href')).toBe('/b/team/lead')
  expect(screen.getByText('Works in')).toBeDefined()
  expect(screen.getByText('/srv/app')).toBeDefined()
  expect(screen.getByRole('link', { name: 'Message' }).getAttribute('href')).toBe('/b?with=builder')
  expect(screen.getByRole('button', { name: 'Pause builder' })).toBeDefined()
  expect(screen.getByRole('link', { name: 'Watch builder work' }).getAttribute('href')).toBe(
    '/now/watch/builder',
  )
  expect(screen.getByRole('button', { name: 'Open builder in its own window' })).toBeDefined()

  fireEvent.click(screen.getByRole('button', { name: /^More: memory/ }))
  const nav = await screen.findByRole('navigation', { name: 'Agent settings sections' })
  for (const tab of [
    'Overview',
    'Personality',
    'Model',
    'Skills',
    'Memory',
    'Tools',
    'Plugins',
    'Workspace',
    'Routines',
    'Channels',
    'Permissions',
    'History',
    'Appearance',
    'Todo',
    'Details',
  ]) {
    const link = within(nav).getByRole('link', { name: tab })
    const target = link.getAttribute('href')!
    await waitFor(() => expect(document.querySelector(target)).not.toBeNull())
  }
  expect(screen.getByRole('heading', { name: 'Memory', level: 2 })).toBeDefined()
  expect(screen.getByText('Nothing on its todo list.')).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Agent details', level: 2 })).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Danger zone', level: 2 })).toBeDefined()
})

test('Asks you first checkboxes update the permission through the classic mutation', async () => {
  open('/b/team/builder')
  const asks = await screen.findByRole('region', { name: 'Asks you first before' })
  const install = within(asks).getByRole('checkbox', { name: 'Installing packages' })
  expect((install as HTMLInputElement).checked).toBe(true)
  expect(asks.getAttribute('data-protected')).toBe('block')
  fireEvent.click(install)
  await waitFor(() => {
    const call = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) =>
          String(input).endsWith('/api/agents/builder/permissions/install%20packages') &&
          init?.method === 'PATCH',
      )
    expect(call).toBeDefined()
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ level: 'allowed' })
  })
})

test('More offers the appearance editor with the pet pack', async () => {
  open('/b/team/builder')
  fireEvent.click(await screen.findByRole('button', { name: /^More: memory/ }))
  const appearance = document.querySelector('#agent-appearance')!
  fireEvent.click(
    within(appearance as HTMLElement).getByRole('button', {
      name: /Change builder.s look, colour and shape/,
    }),
  )
  expect(await screen.findByRole('dialog', { name: 'Agent appearance' })).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Pet pack', level: 3 })).toBeDefined()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog', { name: 'Agent appearance' })).toBeNull()
})

test('a pause that fails still offers the same action again', async () => {
  let attempts = 0
  pauseReply = () =>
    ++attempts === 1
      ? Response.json(
          { error: { code: 'hermes_unavailable', message: 'Some tasks couldn’t be held.' } },
          { status: 502 },
        )
      : Response.json(builder)
  open('/b/team/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Pause builder' }))
  const retry = await screen.findByRole('button', { name: 'Pause again builder' })
  fireEvent.click(retry)
  await waitFor(() => {
    const calls = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).endsWith('/api/agents/builder/pause'))
    expect(calls).toHaveLength(2)
  })
})

test('an agent that cannot load says so and offers a retry', async () => {
  detailReply = () =>
    Response.json({ error: { code: 'not_found', message: 'gone' } }, { status: 404 })
  open('/b/team/builder')
  expect(await screen.findByRole('heading', { name: 'Agent unavailable' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined()
})

test('a coding agent gets access, quota, password and the protected Codex note on the same page', async () => {
  open('/b/team/coder')
  expect(await screen.findByRole('heading', { name: 'coder', level: 1 })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Access' })).toBeDefined()
  expect(await screen.findByRole('heading', { name: 'Limits left' })).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'Codex read access' })).toBeNull()
  const reach = screen.getByRole('note')
  expect(reach.getAttribute('data-protected')).toBe('any')
  expect(reach.textContent).toContain('Codex can read every file your user can')
  expect(screen.getByText(/Runs stop using it below 10% of a limit left/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Change access' }))
  fireEvent.click(screen.getByRole('radio', { name: /Full access/ }))
  expect(await screen.findByLabelText('Security password')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

  fireEvent.click(screen.getByRole('button', { name: /^More: tools, workspace, delete/ }))
  const nav = await screen.findByRole('navigation', { name: 'Agent settings sections' })
  for (const tab of ['Overview', 'Workspace', 'History', 'Appearance']) {
    const link = within(nav).getByRole('link', { name: tab })
    await waitFor(() => expect(document.querySelector(link.getAttribute('href')!)).not.toBeNull())
  }
  expect(within(nav).queryByRole('link', { name: 'Memory' })).toBeNull()
})
