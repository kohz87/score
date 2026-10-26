import { AgentDetailSchema, type AgentDetail } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { CanUseCard } from './CanUseCard.tsx'
import { ChannelsCard } from './ChannelsCard.tsx'
import { DeleteCard } from './DeleteCard.tsx'
import { GoAheadCard } from './GoAheadCard.tsx'
import { LooksCard } from './LooksCard.tsx'
import { NameCard } from './NameCard.tsx'
import { NeverCard } from './NeverCard.tsx'
import { PluginsCard } from './PluginsCard.tsx'
import { RemembersCard } from './RemembersCard.tsx'
import { RoutinesCard } from './RoutinesCard.tsx'
import { RunsCard } from './RunsCard.tsx'
import { ScoreAccessCard } from './ScoreAccessCard.tsx'
import { SkillsCard } from './SkillsCard.tsx'
import { TodoCard } from './TodoCard.tsx'
import { WorkspaceCard } from './WorkspaceCard.tsx'

const agent: AgentDetail = AgentDetailSchema.parse({
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

const at = '2026-10-24T10:00:00.000Z'
type Call = { method: string; path: string; body: unknown }
let calls: Call[] = []
let override: ((path: string, method: string, body: unknown) => Response | null) | null = null
let memory: { id: string; text: string; source: string; at: string }[] = []
const disposers: (() => void)[] = []

class Source extends EventTarget {
  close() {}
}

function reply(path: string, method: string, body: unknown): Response {
  const forced = override?.(path, method, body)
  if (forced) return forced
  if (method !== 'GET') {
    if (path.endsWith('/memory') && method === 'POST') {
      memory = [...memory, { id: 'm2', text: (body as { text: string }).text, source: 'you', at }]
      return Response.json(memory[memory.length - 1])
    }
    if (path.includes('/memory/')) {
      memory = []
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
  if (path.endsWith('/memory')) return Response.json({ items: memory, nextCursor: null })
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

const mcp = {
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

beforeEach(() => {
  calls = []
  override = null
  memory = [{ id: 'm1', text: 'Prefers small commits', source: 'you', at }]
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      // Tree and git requests carry a query; the pathname decides.
      if (method !== 'GET' || !/\/workspace\/(git|tree)$|\/workspace$/.test(url.pathname))
        calls.push({ method, path: url.pathname, body })
      return Promise.resolve(reply(url.pathname.replace(/^\/api/, '/api'), method, body))
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
  calls.find((call) => call.method === method && call.path.endsWith(suffix))

test('Remembers lists memories, forgets one and adds one', async () => {
  mount(<RemembersCard agent={agent} />)
  expect(await screen.findByText('Prefers small commits')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Forget: Prefers small commits' }))
  // Forgetting asks first (3.1.0); nothing is sent until it is confirmed.
  expect(sent('DELETE', '/memory/m1')).toBeUndefined()
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Remove memory' })).getByRole('button', {
      name: 'Remove',
    }),
  )
  await waitFor(() => expect(sent('DELETE', '/memory/m1')).toBeDefined())
  fireEvent.change(screen.getByLabelText('New memory'), { target: { value: 'Use pnpm' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  await waitFor(() => expect(sent('POST', '/memory')?.body).toEqual({ text: 'Use pnpm' }))
  expect(await screen.findByText('Use pnpm')).toBeDefined()
})

test('Skills turn off and on, and the hub result is added', async () => {
  mount(<SkillsCard agent={agent} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Turn off planning' }))
  await waitFor(() => expect(sent('PATCH', '/skills/planning')?.body).toEqual({ enabled: false }))
  fireEvent.click(screen.getByRole('button', { name: 'Turn on sketching' }))
  await waitFor(() => expect(sent('PATCH', '/skills/sketching')?.body).toEqual({ enabled: true }))
  fireEvent.change(screen.getByLabelText('Find a skill'), { target: { value: 'writ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Add writer' }))
  await waitFor(() => expect(sent('POST', '/skills')?.body).toEqual({ name: 'hub/writer' }))
})

test('Can use switches a tool, lists tool servers and links to Settings', async () => {
  mount(<CanUseCard agent={agent} coding={false} />)
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Files' }))
  await waitFor(() => expect(sent('PATCH', '/tools/files')?.body).toEqual({ enabled: true }))
  expect(screen.getByText(/Tool servers: Search server/)).toBeDefined()
  expect(screen.getByRole('link', { name: 'Manage' }).getAttribute('href')).toBe(
    '/b/settings/tools',
  )
})

test('Workspace shows the newest files first and opens one', async () => {
  const onOpen = vi.fn()
  mount(<WorkspaceCard agent={agent} onOpen={onOpen} />)
  const first = await screen.findByRole('button', { name: /events\.py/ })
  expect(screen.getByText(/Branch main · 2 files changed/)).toBeDefined()
  fireEvent.click(first)
  expect(onOpen).toHaveBeenCalledWith('events.py')
  fireEvent.click(screen.getByRole('button', { name: 'Browse all files' }))
  expect(onOpen).toHaveBeenLastCalledWith(null)
  fireEvent.click(screen.getByRole('button', { name: 'Set folder' }))
  expect(screen.getByRole('textbox', { name: 'Folder on this computer' })).toBeDefined()
})

test('Repeating jobs run now and link to Start a job', async () => {
  mount(<RoutinesCard agent={agent} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Run Nightly tests now' }))
  await waitFor(() => expect(sent('POST', '/routines/r1/run')).toBeDefined())
  expect(screen.getByRole('link', { name: 'Start a repeating job' }).getAttribute('href')).toBe(
    '/b?start=job',
  )
})

test('Delete only asks the page to open its Remove panel', () => {
  const onDelete = vi.fn()
  mount(<DeleteCard agent={agent} onDelete={onDelete} />)
  expect(screen.getByText(/A private export is kept first/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }))
  expect(onDelete).toHaveBeenCalledTimes(1)
  expect(calls).toHaveLength(0)
})

test('Plugins toggle, and a locked one stays on', async () => {
  mount(<PluginsCard agent={agent} />)
  fireEvent.click(await screen.findByRole('checkbox', { name: /Extra/ }))
  await waitFor(() =>
    expect(sent('PATCH', '/settings/plugins/extra')?.body).toEqual({ enabled: true }),
  )
  expect(
    (screen.getByRole('checkbox', { name: /Score bridge/ }) as HTMLInputElement).disabled,
  ).toBe(true)
})

test('Channels show the state and open the setup for one that is not connected', async () => {
  mount(<ChannelsCard agent={agent} />)
  expect(await screen.findByText('Connected')).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Connect Slack' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Connect Telegram' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Connect Telegram' })).toBeNull())
})

test('Never rules list, add one, and are a protected surface', async () => {
  mount(<NeverCard agent={agent} />)
  const card = screen.getByRole('region', { name: /Never rules/ })
  expect(card.getAttribute('data-protected')).toBe('block')
  expect(within(card).getByText('rm -rf *')).toBeDefined()
  fireEvent.change(within(card).getByLabelText('Never allow commands that match'), {
    target: { value: '*git* push*' },
  })
  fireEvent.click(within(card).getByRole('button', { name: 'Add' }))
  await waitFor(() =>
    expect(sent('PATCH', '/permissions/never%3A*git*%20push*')?.body).toEqual({ level: 'never' }),
  )
})

test('Looks offers the colour and shape picker', async () => {
  mount(<LooksCard agent={agent} />)
  fireEvent.click(screen.getByRole('button', { name: /Change builder.s colour and shape/ }))
  expect(await screen.findByRole('dialog', { name: 'Agent appearance' })).toBeDefined()
})

test('Name and role save through the agent endpoint', async () => {
  mount(<NameCard agent={agent} />)
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Builder One' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
  await waitFor(() =>
    expect(sent('PATCH', '/agents/builder')?.body).toEqual({
      name: 'Builder One',
      role: 'Builds features',
    }),
  )
  expect(await screen.findByText('Details saved.')).toBeDefined()
})

test('Recent runs link to the replay', async () => {
  mount(<RunsCard agent={agent} />)
  expect(await screen.findByText('Fix the feed')).toBeDefined()
  expect(screen.getByRole('link', { name: 'Replay Fix the feed' }).getAttribute('href')).toBe(
    '/watch/builder?from=7',
  )
})

test('Score access switches read access and creates no key by itself', async () => {
  mount(<ScoreAccessCard agent={agent} />)
  const card = await screen.findByRole('region', { name: 'Score access' })
  expect(card.getAttribute('data-protected')).toBe('flex')
  fireEvent.click(await within(card).findByRole('checkbox', { name: /Read rooms/ }))
  await waitFor(() => expect(sent('PUT', '/mcp')?.body).toEqual({ enabled: true }))
  expect(calls.some((call) => call.path.endsWith('/mcp/token'))).toBe(false)
})

test('Todo lists the items with their state in words', async () => {
  mount(<TodoCard agent={agent} />)
  expect(await screen.findByText('Write tests')).toBeDefined()
  expect(screen.getByText('To do')).toBeDefined()
})

const token = `scm_${'a'.repeat(43)}`

test('Score access: a key is shown once, replaced, revoked, and Write too toggles', async () => {
  override = (path, method, body) => {
    if (path.endsWith('/mcp/token') && method === 'POST')
      return Response.json({
        token,
        access: { ...mcp, enabled: true, hasToken: true, tokenCreatedAt: at },
      })
    if (path.endsWith('/mcp/token') && method === 'DELETE')
      return Response.json({ ...mcp, enabled: true, hasToken: false })
    if (path.endsWith('/mcp') && method === 'PUT')
      return Response.json({ ...mcp, enabled: true, hasToken: true, ...(body as object) })
    if (path.endsWith('/mcp') && method === 'GET')
      return Response.json({ ...mcp, enabled: true, hasToken: false })
    return null
  }
  mount(<ScoreAccessCard agent={agent} />)
  const card = await screen.findByRole('region', { name: 'Score access' })
  fireEvent.click(await within(card).findByRole('button', { name: 'Create key' }))
  expect(await within(card).findByText(token)).toBeDefined()
  expect(sent('POST', '/mcp/token')).toBeDefined()
  fireEvent.click(within(card).getByRole('checkbox', { name: /Write too/ }))
  await waitFor(() => expect(sent('PUT', '/mcp')?.body).toEqual({ writesEnabled: true }))
  fireEvent.click(await within(card).findByRole('button', { name: 'Revoke' }))
  await waitFor(() => expect(sent('DELETE', '/mcp/token')).toBeDefined())
  await waitFor(() => expect(within(card).queryByText(token)).toBeNull())
})

test('Score access keeps the card with a retry when it cannot load', async () => {
  let fail = true
  override = (path, method) =>
    path.endsWith('/mcp') && method === 'GET' && fail
      ? Response.json({ error: { code: 'unavailable', message: 'MCP is down.' } }, { status: 500 })
      : null
  mount(<ScoreAccessCard agent={agent} />)
  const card = await screen.findByRole('region', { name: 'Score access' })
  expect(await within(card).findByText(/MCP is down\./)).toBeDefined()
  expect(card.getAttribute('data-protected')).toBe('flex')
  fail = false
  fireEvent.click(within(card).getByRole('button', { name: 'Try again' }))
  expect(await within(card).findByRole('checkbox', { name: /Read rooms/ })).toBeDefined()
})

test('Goes ahead without asking can take a standing grant back, and a team rule is used again', async () => {
  const granted: AgentDetail = {
    ...agent,
    permissions: [
      { id: 'push code', label: 'Pushing code', level: 'allowed', inherited: false },
      { id: 'install packages', label: 'Installing packages', level: 'asks', inherited: false },
    ],
  }
  override = (path, method) =>
    path.endsWith('/settings/rules') && method === 'GET'
      ? Response.json({
          mode: 'smart',
          goAhead: [
            {
              id: 'install packages',
              label: 'Installing packages',
              pattern: null,
              readOnly: false,
            },
          ],
          askMe: [],
          never: [],
          drift: [],
        })
      : null
  mount(<GoAheadCard agent={granted} />)
  const card = screen.getByRole('region', { name: /Goes ahead without asking/ })
  expect(card.getAttribute('data-protected')).toBe('block')
  fireEvent.click(within(card).getByRole('button', { name: 'Ask first before: Pushing code' }))
  await waitFor(() =>
    expect(sent('PATCH', '/permissions/push%20code')?.body).toEqual({ level: 'asks' }),
  )
  fireEvent.click(
    await within(card).findByRole('button', { name: 'Use team rule: Installing packages' }),
  )
  await waitFor(() => expect(sent('DELETE', '/permissions/install%20packages')).toBeDefined())
})

test('Never: an own rule goes back to the team rule', async () => {
  mount(<NeverCard agent={agent} />)
  fireEvent.click(screen.getByRole('button', { name: 'Use team rule instead of: rm -rf *' }))
  await waitFor(() => expect(sent('DELETE', '/permissions/never%3Arm%20-rf%20*')).toBeDefined())
  expect(screen.queryByRole('button', { name: /instead of: sudo/ })).toBeNull()
})

test('failures show the server’s own message', async () => {
  override = (path, method) =>
    method === 'PATCH' && path === '/api/agents/builder'
      ? Response.json(
          { error: { code: 'conflict', message: 'That name is taken.' } },
          { status: 409 },
        )
      : null
  mount(<NameCard agent={agent} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
  expect(await screen.findByText('That name is taken.')).toBeDefined()
})

test('Recent runs: filter by outcome and show each run cost', async () => {
  override = (path) => {
    if (!path.includes('/history')) return null
    const failed = path.includes('outcome=failed')
    const items = [
      {
        runId: 'run-1',
        title: 'Fix the feed',
        origin: 'score',
        outcome: 'completed',
        startedAt: at,
        durationSec: 60,
        model: null,
        costUsd: 1.5,
        task: null,
        brief: null,
        replaySeq: 7,
      },
      {
        runId: 'run-2',
        title: 'Break the build',
        origin: 'score',
        outcome: 'failed',
        startedAt: at,
        durationSec: 5,
        model: null,
        costUsd: null,
        task: null,
        brief: null,
        replaySeq: null,
      },
    ]
    return Response.json({
      items: failed ? items.filter((run) => run.outcome === 'failed') : items,
      nextCursor: null,
    })
  }
  mount(<RunsCard agent={agent} />)
  expect(await screen.findByText('Fix the feed')).toBeDefined()
  expect(screen.getByText(/\$1\.50/)).toBeDefined()
  expect(screen.getByText(/cost unknown/)).toBeDefined()
  const group = screen.getByRole('group', { name: 'Filter runs by outcome' })
  fireEvent.click(within(group).getByRole('button', { name: 'Failed' }))
  await waitFor(() => expect(screen.queryByText('Fix the feed')).toBeNull())
  expect(await screen.findByText('Break the build')).toBeDefined()
  expect(within(group).getByRole('button', { name: 'Failed' }).getAttribute('aria-pressed')).toBe(
    'true',
  )
  fireEvent.click(within(group).getByRole('button', { name: 'All' }))
  expect(await screen.findByText('Fix the feed')).toBeDefined()
})

test('Remembers searches as you type with matches marked, and a cancelled forget sends nothing', async () => {
  memory = [
    { id: 'm1', text: 'Prefers small commits', source: 'you', at },
    { id: 'm3', text: 'Deploys on Fridays', source: 'you', at },
  ]
  mount(<RemembersCard agent={agent} />)
  expect(await screen.findByText('Deploys on Fridays')).toBeDefined()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search memory' }), {
    target: { value: 'COMMIT' },
  })
  expect(screen.queryByText('Deploys on Fridays')).toBeNull()
  expect(document.querySelector('mark')?.textContent).toBe('commit')
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search memory' }), {
    target: { value: 'zzz' },
  })
  expect(screen.getByText('No memories match “zzz”.')).toBeDefined()
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search memory' }), {
    target: { value: '' },
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Forget: Deploys on Fridays' }))
  const confirm = screen.getByRole('group', { name: 'Remove memory' })
  expect(confirm.getAttribute('data-protected')).toBe('block')
  fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('group', { name: 'Remove memory' })).toBeNull()
  expect(sent('DELETE', '/memory/m3')).toBeUndefined()
})
