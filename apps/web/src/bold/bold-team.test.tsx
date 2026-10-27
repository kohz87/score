import {
  AgentDetailSchema,
  PROFILE_IMPORT_MAX_BYTES,
  type AgentDetail,
  type CodingAgent,
} from '@score/contract'
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
  effort: null,
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
const localRunsOn = {
  backend: 'local',
  raw: 'local',
  separated: 'no',
  docker: null,
  ssh: null,
  separatedTools: [],
  hostTools: [],
  notes: ['Everything the agent does runs on this machine as you.'],
  checked: { how: 'live', hermes: '0.21.5 (e97923c)', at: '2026-10-24' },
}
const dockerRunsOn = {
  backend: 'docker',
  raw: 'docker',
  separated: 'partly',
  docker: {
    image: 'sandbox:1',
    network: false,
    mountsWorkspace: false,
    runsAsRoot: true,
    extraMounts: 0,
  },
  ssh: null,
  separatedTools: ['Terminal commands and background processes'],
  hostTools: ['MCP servers'],
  notes: ['Commands run as root inside the container.'],
  checked: { how: 'live', hermes: '0.21.5 (e97923c)', at: '2026-10-24' },
}
let runsOn: Record<string, unknown> = localRunsOn
let runsOnPuts: unknown[] = []
let detailReply: () => Response
let watchReply: () => Response
let pauseReply: (() => Response) | null
let previewReply: () => Response
let createReply: () => Response
let runsOnReply: (() => Response) | null
let previewHold: Promise<void> | null
let runtimeCalls = 0
const disposers: (() => void)[] = []

const codingRuntimes = [
  {
    runtime: 'claude-code',
    label: 'Claude Code',
    state: 'ready',
    version: '2.1.295',
    testedVersions: ['2.1.295'],
    quota: 'Uses your Claude plan quota.',
    message: null,
    unverifiedPermissions: [],
    warning: null,
  },
  {
    runtime: 'codex',
    label: 'Codex',
    state: 'ready',
    version: '0.160.1',
    testedVersions: ['0.160.1'],
    quota: 'Uses your ChatGPT plan quota.',
    message: null,
    unverifiedPermissions: [],
    warning: null,
  },
  {
    runtime: 'antigravity',
    label: 'Antigravity (agy)',
    state: 'not_installed',
    version: null,
    testedVersions: ['1.3.3'],
    quota: 'Uses your Google plan quota.',
    message: 'Antigravity (agy) is not installed or not on PATH.',
    unverifiedPermissions: ['full'],
    warning: null,
  },
] as const

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

function completedOperation(): Response {
  return Response.json({
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'create',
    targetName: 'runs-agent',
    incarnationId: '22222222-2222-4222-8222-222222222222',
    requestHash: 'a'.repeat(64),
    state: 'completed',
    steps: [],
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:01.000Z',
    nextStep: null,
    error: null,
    exportPath: null,
  })
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
  agentsReply = () =>
    Response.json({
      asOfSeq: 1,
      items: [builder, coderDetail, { ...builder, id: 'lead', name: 'lead', reportsTo: null }],
    })
  runsOn = localRunsOn
  runsOnPuts = []
  detailReply = () => agentResponse(builder)
  pauseReply = null
  createReply = completedOperation
  runsOnReply = null
  previewHold = null
  runtimeCalls = 0
  previewReply = () =>
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
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      if (url.pathname === '/api/agents' && init?.method === 'POST')
        return Promise.resolve(createReply())
      if (url.pathname === '/api/agents') return Promise.resolve(agentsReply())
      if (url.pathname.startsWith('/api/agents/operations/')) return Promise.resolve(createReply())
      if (url.pathname === '/api/agents/runs-agent/runs-on' && init?.method === 'PUT')
        return Promise.resolve(runsOnReply?.() ?? Response.json(dockerRunsOn))
      if (url.pathname === '/api/agents/builder/runs-on') {
        if (init?.method === 'PUT') {
          runsOnPuts.push(JSON.parse(String(init.body)))
          runsOn = { ...runsOn, ...dockerRunsOn }
        }
        return Promise.resolve(Response.json(runsOn))
      }
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
      if (url.pathname === '/api/agents/preview')
        return previewHold
          ? previewHold.then(() => previewReply())
          : Promise.resolve(previewReply())
      if (url.pathname === '/api/coding-agents/runtimes') {
        runtimeCalls += 1
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

test('?add=agent opens the Add an agent dialog with all 22 shapes and taken colours disabled', async () => {
  open('/b/team?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })

  const shapes = within(dialog).getByRole('radiogroup', { name: 'Shape' })
  expect(within(shapes).getAllByRole('radio')).toHaveLength(22)
  fireEvent.click(within(shapes).getByRole('radio', { name: 'circle dot' }))
  expect(within(dialog).getByRole('img', { name: 'New agent, circle-dot' })).toBeDefined()

  const colours = within(dialog).getByRole('radiogroup', { name: 'Colour' })
  const taken = within(colours).getByRole('radio', {
    name: 'Colour #19c39a, used by builder',
  }) as HTMLInputElement
  expect(taken.disabled).toBe(true)
  const free = within(colours).getByRole('radio', { name: 'Colour #2bb3c0' }) as HTMLInputElement
  fireEvent.click(free)
  expect(free.checked).toBe(true)
})

test('a full palette starts a new agent on an enabled generated colour', async () => {
  const palette = ['#6b8cff', '#2bb3c0', '#ff8a3d', '#8bd450']
  agentsReply = () =>
    Response.json({
      asOfSeq: 1,
      items: palette.map((color, index) => ({
        ...builder,
        id: `agent-${index}`,
        name: `agent-${index}`,
        reportsTo: null,
        style: { color, shape: 'hexagon' },
      })),
    })
  open('/b/team?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  const colours = within(dialog).getByRole('radiogroup', { name: 'Colour' })
  const radios = within(colours).getAllByRole('radio') as HTMLInputElement[]
  const selected = await waitFor(() => {
    const choice = (within(colours).getAllByRole('radio') as HTMLInputElement[]).find(
      (radio) => radio.checked,
    )
    expect(choice?.disabled).toBe(false)
    return choice
  })
  expect(selected).toBeDefined()
  expect(radios.filter((radio) => !radio.disabled).length).toBeGreaterThan(0)
  expect(radios.length).toBeGreaterThan(palette.length)
})

test('the bold dialog reuses the classic preview hash and inheritance confirmation when copying', async () => {
  open('/b/team?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'researcher' } })
  fireEvent.change(within(dialog).getByLabelText('What does it do?'), {
    target: { value: 'Finds and compares options.' },
  })
  fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'fake-model' } })
  fireEvent.change(within(dialog).getByLabelText('Copy from'), {
    target: { value: 'builder' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview changes' }))

  expect(await within(dialog).findByRole('heading', { name: 'Review changes' })).toBeDefined()
  expect(within(dialog).getByText('Create profile researcher')).toBeDefined()
  expect(within(dialog).getByText('Release notes go through reviewer first.')).toBeDefined()
  expect(
    within(dialog).getByRole('button', { name: 'Add researcher' }).hasAttribute('disabled'),
  ).toBe(true)
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /what this agent inherits/ }))
  expect(
    within(dialog).getByRole('button', { name: 'Add researcher' }).hasAttribute('disabled'),
  ).toBe(false)
})

test('the coding tool shows install state and checks the CLI version again', async () => {
  open('/b/team?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  fireEvent.click(within(dialog).getByRole('radio', { name: /A coding tool/ }))
  expect(await within(dialog).findByText(/Installed · version 2\.1\.295/)).toBeDefined()
  expect(within(dialog).queryByLabelText('Works on')).toBeNull()
  expect(within(dialog).getByText('Runs on this machine as you.')).toBeDefined()
  expect(
    (within(dialog).getByRole('radio', { name: 'Claude Code' }) as HTMLInputElement).type,
  ).toBe('radio')

  const initialCalls = runtimeCalls
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check version again' }))
  await waitFor(() => expect(runtimeCalls).toBeGreaterThan(initialCalls))

  fireEvent.click(within(dialog).getByRole('radio', { name: 'Antigravity (agy)' }))
  expect(
    await within(dialog).findByText(/Antigravity \(agy\) is not installed/, { exact: false }),
  ).toBeDefined()

  fireEvent.click(within(dialog).getByRole('radio', { name: 'Codex' }))
  expect(await within(dialog).findByRole('checkbox', { name: /can read any file/ })).toBeDefined()
})

test('the import size hint follows the contract maximum', async () => {
  open('/b/team?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  fireEvent.click(within(dialog).getByRole('radio', { name: /Bring in a Hermes profile/ }))
  const megabytes = Math.round(PROFILE_IMPORT_MAX_BYTES / (1024 * 1024))
  expect(within(dialog).getByText(`Profile export (.tar.gz, up to ${megabytes} MB)`)).toBeDefined()
})

test('while setup is running Escape and the backdrop leave the dialog open and the X asks first', async () => {
  let releasePreview: () => void = () => {}
  previewHold = new Promise<void>((resolve) => {
    releasePreview = resolve
  })
  open('/b/team?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'busy-agent' } })
  fireEvent.change(within(dialog).getByLabelText('What does it do?'), {
    target: { value: 'Waits for the preview.' },
  })
  fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'fake-model' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview changes' }))
  await within(dialog).findByRole('button', { name: 'Loading preview…' })

  const cancel = new Event('cancel', { bubbles: true, cancelable: true })
  fireEvent(dialog, cancel)
  expect(cancel.defaultPrevented).toBe(true)
  expect(screen.getByRole('dialog', { name: 'Add an agent' })).toBe(dialog)

  fireEvent.click(dialog)
  expect(screen.getByRole('dialog', { name: 'Add an agent' })).toBe(dialog)

  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  const confirm = within(dialog).getByRole('alertdialog', {
    name: 'Close while it’s still running?',
  })
  expect(confirm.getAttribute('data-protected')).toBe('block')
  fireEvent.click(within(confirm).getByRole('button', { name: 'Keep waiting' }))

  previewHold = null
  releasePreview()
  expect(await within(dialog).findByRole('heading', { name: 'Review changes' })).toBeDefined()
})

test('a non-local Works on choice is saved after setup and a 409 reason is shown with retry', async () => {
  runsOnReply = () =>
    Response.json(
      {
        error: {
          code: 'backend_unavailable',
          message: 'Docker isn’t installed or its daemon is not running.',
        },
      },
      { status: 409 },
    )
  open('/b/team?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'runs-agent' } })
  fireEvent.change(within(dialog).getByLabelText('What does it do?'), {
    target: { value: 'Runs checks in a box.' },
  })
  fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'fake-model' } })
  expect(within(dialog).getByRole('option', { name: 'Docker (partly separated)' })).toBeDefined()
  fireEvent.change(within(dialog).getByLabelText('Works on'), { target: { value: 'docker' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview changes' }))
  await within(dialog).findByRole('heading', { name: 'Review changes' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add runs-agent' }))

  expect(
    await within(dialog).findByText('Docker isn’t installed or its daemon is not running.'),
  ).toBeDefined()
  const calls = () =>
    vi
      .mocked(fetch)
      .mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith('/api/agents/runs-agent/runs-on') && init?.method === 'PUT',
      )
  await waitFor(() => expect(calls()).toHaveLength(1))
  expect(JSON.parse(String(calls()[0]?.[1]?.body))).toEqual({ backend: 'docker' })

  runsOnReply = null
  fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }))
  expect(
    await within(dialog).findByRole('heading', { name: 'runs-agent joined the team' }),
  ).toBeDefined()
  expect(calls()).toHaveLength(2)
  expect(within(dialog).getByText(/Docker · Partly separated/)).toBeDefined()
  expect(within(dialog).getByText(/Commands run as root inside the container\./)).toBeDefined()
  expect(within(dialog).getByRole('link', { name: 'Where it works' }).getAttribute('href')).toBe(
    '/b/team/runs-agent#agent-where',
  )
})

test('continuing past a failed Works on write says the agent runs on this machine, with the reason', async () => {
  runsOnReply = () =>
    Response.json(
      {
        error: {
          code: 'backend_unavailable',
          message: 'Docker isn’t installed or its daemon is not running.',
        },
      },
      { status: 409 },
    )
  open('/b/team?add=agent')
  const dialog = await screen.findByRole('dialog', { name: 'Add an agent' })
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'runs-agent' } })
  fireEvent.change(within(dialog).getByLabelText('What does it do?'), {
    target: { value: 'Runs checks in a box.' },
  })
  fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'fake-model' } })
  fireEvent.change(within(dialog).getByLabelText('Works on'), { target: { value: 'docker' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview changes' }))
  await within(dialog).findByRole('heading', { name: 'Review changes' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add runs-agent' }))

  expect(
    await within(dialog).findByText('Docker isn’t installed or its daemon is not running.'),
  ).toBeDefined()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue on this machine' }))
  expect(
    await within(dialog).findByText(
      'Runs on this machine as you: Docker isn’t installed or its daemon is not running.',
    ),
  ).toBeDefined()
  expect(within(dialog).getByRole('link', { name: 'Where it works' }).getAttribute('href')).toBe(
    '/b/team/runs-agent#agent-where',
  )
})

test('the agent page puts the four cards first and the compact More cards under the toggle', async () => {
  open('/b/team/builder')
  expect(await screen.findByRole('heading', { name: 'builder', level: 1 })).toBeDefined()
  expect(screen.getByText('How builder works')).toBeDefined()
  expect(await screen.findByRole('textbox', { name: 'SOUL.md contents' })).toBeDefined()
  expect(screen.getByText('Hermes')).toBeDefined()
  expect(screen.getByText('Next model')).toBeDefined()
  expect(screen.getByText(/Falls back to demo\/safe/)).toBeDefined()
  expect(await screen.findByText('This machine, as you')).toBeDefined()
  expect(screen.getByText('Not separated')).toBeDefined()
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
  expect(screen.getByRole('link', { name: 'Look at its screen' }).getAttribute('href')).toBe(
    '/b/screen/builder',
  )
  expect(screen.queryByRole('button', { name: 'Open builder in its own window' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: /^More: memory/ }))
  expect(screen.queryByRole('navigation', { name: 'Agent settings sections' })).toBeNull()
  const more = await screen.findByRole('button', { name: 'Less' })
  expect(more.getAttribute('aria-expanded')).toBe('true')
  for (const title of [
    'Remembers',
    'Skills',
    'Can use',
    'Workspace',
    'Repeating jobs',
    'Delete builder',
    'Plugins',
    'Channels',
    'Never rules',
    'Looks',
    'Name and role',
    'Recent runs',
    'Todo',
  ])
    expect(
      await screen.findByRole('heading', { name: new RegExp(`^${title}`), level: 3 }),
    ).toBeDefined()
  // None of the classic Team tab sections are used any more.
  expect(document.querySelector('#agent-more .team-card')).toBeNull()
  expect(await screen.findByText('Nothing on its todo list.')).toBeDefined()
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

test('More offers the appearance editor', async () => {
  open('/b/team/builder')
  fireEvent.click(await screen.findByRole('button', { name: /^More: memory/ }))
  const appearance = document.querySelector('#agent-appearance')!
  fireEvent.click(
    within(appearance as HTMLElement).getByRole('button', {
      name: /Change builder.s colour and shape/,
    }),
  )
  expect(await screen.findByRole('dialog', { name: 'Agent appearance' })).toBeDefined()
  expect(screen.getByRole('radio', { name: 'star' })).toBeDefined()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog', { name: 'Agent appearance' })).toBeNull()
})

test('a workspace link (?path=) opens More and the Files panel', async () => {
  open('/b/team/builder?path=docs%2Fplan.md')
  expect(await screen.findByRole('heading', { name: 'Files' })).toBeDefined()
  expect(document.querySelector('#agent-files')).not.toBeNull()
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

type LifeState = 'setting_up' | 'ready' | 'deleting' | 'needs_attention' | 'removed'
function withLifecycle(state: LifeState, status?: 'paused') {
  const lifecycle = {
    state,
    incarnationId: '22222222-2222-4222-8222-222222222222',
    operationId: '11111111-1111-4111-8111-111111111111',
  }
  const agent = { ...builder, lifecycle, ...(status ? { status } : {}) }
  agentsReply = () => Response.json({ asOfSeq: 1, items: [agent] })
  detailReply = () => agentResponse(agent as AgentDetail)
  createReply = () =>
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

test.each([
  ['setting_up', false, false],
  ['deleting', false, false],
  ['needs_attention', true, false],
  ['ready', true, true],
] as const)('a %s agent: Remove agent… shown %s, Pause shown %s', async (state, remove, pause) => {
  withLifecycle(state)
  open('/b/team/builder')
  await screen.findByRole('heading', { name: 'builder', level: 1 })
  if (state !== 'ready') await screen.findByLabelText('builder status')
  expect(screen.queryByRole('button', { name: 'Remove agent…' }) !== null).toBe(remove)
  expect(screen.queryByRole('button', { name: /^(Pause|Resume) builder/u }) !== null).toBe(pause)
})

test('a ready agent with a pause recorded offers Resume', async () => {
  withLifecycle('ready', 'paused')
  open('/b/team/builder')
  expect(await screen.findByRole('button', { name: 'Resume builder' })).toBeDefined()
})

test('opening a removed agent’s page directly stays on it, with its history and no Pause or Remove', async () => {
  withLifecycle('removed')
  const { router } = open('/b/team/builder')
  await screen.findByRole('heading', { name: 'builder', level: 1 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(router.state.location.pathname).toBe('/b/team/builder')
  expect(screen.queryByRole('button', { name: 'Remove agent…' })).toBeNull()
  expect(screen.queryByRole('button', { name: /^(Pause|Resume) builder/u })).toBeNull() // 3.5.1: no one-to-one to start with an agent that has left.
  expect(screen.queryByRole('link', { name: 'Message' })).toBeNull()
})

test('a page that saw the agent go from deleting to removed leaves for Team', async () => {
  // The fenced list only changes on stream events; this page reads the detail when the list lacks the agent.
  withLifecycle('deleting')
  agentsReply = () => Response.json({ asOfSeq: 1, items: [] })
  const { router, queryClient } = open('/b/team/builder')
  await screen.findByLabelText('builder status')
  withLifecycle('removed')
  agentsReply = () => Response.json({ asOfSeq: 1, items: [] })
  void queryClient.invalidateQueries({ queryKey: ['team', 'detail', 'builder'] })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/team'))
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
  expect(screen.queryByRole('navigation', { name: 'Agent settings sections' })).toBeNull()
  for (const title of [
    'Can use',
    'Workspace',
    'Recent runs',
    'Looks',
    'Name and role',
    'Delete coder',
  ])
    expect(
      await screen.findByRole('heading', { name: new RegExp(`^${title}`), level: 3 }),
    ).toBeDefined()
  expect(screen.queryByRole('heading', { name: /^Remembers/ })).toBeNull()
})

test('Where it works says exactly what Docker separates and changes through the API', async () => {
  open('/b/team/builder')
  const card = await screen.findByRole('region', { name: 'Where it works' })
  expect(await within(card).findByText('Not separated')).toBeDefined()
  expect(card.getAttribute('data-protected')).toBe('block')
  fireEvent.click(within(card).getByRole('button', { name: 'Change where it works' }))
  fireEvent.click(within(card).getByRole('radio', { name: 'Docker' }))
  fireEvent.click(
    within(card).getByRole('checkbox', { name: 'Let the container reach the network' }),
  )
  fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
  expect(await within(card).findByText('Partly separated')).toBeDefined()
  expect(runsOnPuts).toEqual([{ backend: 'docker', network: false }])
  expect(within(card).getByText(/Still on this machine as you:/)).toBeDefined()
  expect(within(card).getByText(/MCP servers/)).toBeDefined()
  expect(within(card).getByText('Commands run as root inside the container.')).toBeDefined()
})

const deleteOp = (state: 'running' | 'completed') => ({
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

function deletePreview(blockers: string[] = []) {
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

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> }
/** Wraps the stubbed fetch so the delete endpoints answer with `reply`, and records those calls. */
function stubDelete(reply: (call: Call) => Response | null) {
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

test('Remove agent… shows the preview in place; blockers and the typed name gate Remove', async () => {
  const calls = stubDelete((call) =>
    call.url === '/api/agents/preview'
      ? Response.json(deletePreview(['builder is mid-run on a shared file']))
      : null,
  )
  const { router } = open('/b/team/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  expect(panel.getAttribute('data-protected')).toBe('block')
  expect(await within(panel).findByText(/1 active runs · 2 queued messages/)).toBeDefined()
  expect(within(panel).getByText(/4 unfinished assignments/)).toBeDefined()
  expect(within(panel).getByText('Its unfinished work goes back to the lead.')).toBeDefined()
  expect(within(panel).getByText(/A private copy is kept first:/)).toBeDefined()
  expect(within(panel).getByText('/home/user/.score/exports/builder.tar')).toBeDefined()
  expect(within(panel).getByText(/isn’t a full undo/)).toBeDefined()
  expect(within(panel).getByRole('alert').textContent).toBe('builder is mid-run on a shared file')
  const input = within(panel).getByLabelText('Type builder to confirm')
  fireEvent.change(input, { target: { value: 'builder' } })
  expect(
    (within(panel).getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  expect(router.state.location.pathname).toBe('/b/team/builder')
})

test('typing the name enables Remove; DELETE carries the name, the preview hash and an Idempotency-Key, then it goes to Team', async () => {
  let polls = 0
  const calls = stubDelete((call) => {
    if (call.url === '/api/agents/preview') return Response.json(deletePreview())
    if (call.method === 'DELETE') return Response.json(deleteOp('running'), { status: 202 })
    polls += 1
    return Response.json(deleteOp(polls > 1 ? 'completed' : 'running'))
  })
  const { router } = open('/b/team/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  const input = await within(panel).findByLabelText('Type builder to confirm')
  const remove = within(panel).getByRole('button', { name: 'Remove' }) as HTMLButtonElement
  expect(remove.disabled).toBe(true)
  fireEvent.change(input, { target: { value: 'builde' } })
  expect(remove.disabled).toBe(true)
  fireEvent.change(input, { target: { value: 'builder' } })
  expect(remove.disabled).toBe(false)
  fireEvent.click(remove)
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/team'))
  const del = calls.find((call) => call.method === 'DELETE')!
  expect(del.body).toEqual({ typedName: 'builder', previewHash: 'b'.repeat(64) })
  expect(Object.keys(del.headers).map((key) => key.toLowerCase())).toContain('idempotency-key')
})

test('a Hermes agent the server refuses to remove shows the server message and stays', async () => {
  stubDelete((call) => {
    if (call.url === '/api/agents/preview') return Response.json(deletePreview())
    if (call.method === 'DELETE')
      return Response.json(
        { error: { code: 'agent_busy', message: 'builder started a run a moment ago.' } },
        { status: 409 },
      )
    return null
  })
  const { router } = open('/b/team/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  fireEvent.change(await within(panel).findByLabelText('Type builder to confirm'), {
    target: { value: 'builder' },
  })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  expect((await within(panel).findByRole('alert')).textContent).toContain(
    'builder started a run a moment ago.',
  )
  expect(router.state.location.pathname).toBe('/b/team/builder')
})

test('Cancel and Escape close the panel and put focus back on Remove agent…', async () => {
  stubDelete((call) => (call.url === '/api/agents/preview' ? Response.json(deletePreview()) : null))
  open('/b/team/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  let panel = await screen.findByRole('group', { name: 'Remove builder' })
  const cancel = within(panel).getByRole('button', { name: 'Cancel' })
  await waitFor(() => expect(document.activeElement).toBe(cancel))
  fireEvent.click(cancel)
  expect(screen.queryByRole('group', { name: 'Remove builder' })).toBeNull()
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove agent…' })),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Remove agent…' }))
  panel = await screen.findByRole('group', { name: 'Remove builder' })
  fireEvent.keyDown(within(panel).getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
  expect(screen.queryByRole('group', { name: 'Remove builder' })).toBeNull()
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove agent…' })),
  )
})

test('Remove agent… on a coding agent asks in plain words, with no preview, and removes it', async () => {
  const calls = stubDelete((call) =>
    call.method === 'DELETE' ? new Response(null, { status: 204 }) : null,
  )
  const { router } = open('/b/team/coder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove coder' })
  expect(panel.getAttribute('data-protected')).toBe('block')
  expect(
    within(panel).getByText('Removes coder from the team. Past work stays in rooms.'),
  ).toBeDefined()
  expect(calls.some((call) => call.url === '/api/agents/preview')).toBe(false)
  expect(document.getElementById('agent-more')).toBeNull()
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/team'))
  expect(calls.find((call) => call.method === 'DELETE')!.url).toBe('/api/coding-agents/coder')
})

test('a busy coding agent shows the server message and stays', async () => {
  stubDelete((call) =>
    call.method === 'DELETE'
      ? Response.json(
          { error: { code: 'agent_busy', message: 'coder is working on a job.' } },
          { status: 409 },
        )
      : null,
  )
  const { router } = open('/b/team/coder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove coder' })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  expect((await within(panel).findByRole('alert')).textContent).toContain(
    'coder is working on a job.',
  )
  expect(router.state.location.pathname).toBe('/b/team/coder')
})

test('the default agent has no Remove agent… action', async () => {
  open('/b/team/default')
  expect(await screen.findByRole('heading', { level: 1 })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Remove agent…' })).toBeNull()
})

test('after a refused DELETE the preview reloads, the message stays, and a second attempt succeeds', async () => {
  let deletes = 0
  let previews = 0
  const calls = stubDelete((call) => {
    if (call.url === '/api/agents/preview') {
      previews += 1
      return Response.json(deletePreview())
    }
    if (call.method === 'DELETE') {
      deletes += 1
      return deletes === 1
        ? Response.json(
            { error: { code: 'preview_stale', message: 'builder changed. Review again.' } },
            { status: 409 },
          )
        : Response.json(deleteOp('completed'), { status: 202 })
    }
    return Response.json(deleteOp('completed'))
  })
  const { router } = open('/b/team/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  fireEvent.change(await within(panel).findByLabelText('Type builder to confirm'), {
    target: { value: 'builder' },
  })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(previews).toBe(2))
  const input = await within(panel).findByLabelText('Type builder to confirm')
  expect((input as HTMLInputElement).value).toBe('')
  expect(within(panel).getByRole('alert').textContent).toContain('builder changed. Review again.')
  fireEvent.change(input, { target: { value: 'builder' } })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/team'))
  expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(2)
})

test('while a DELETE is pending Cancel is disabled and Escape does nothing', async () => {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const inner = globalThis.fetch
  stubDelete((call) => (call.url === '/api/agents/preview' ? Response.json(deletePreview()) : null))
  const wrapped = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? held.then(() => new Response(null, { status: 204 }))
        : wrapped(input, init),
    ),
  )
  void inner
  open('/b/team/coder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove coder' })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  await waitFor(() =>
    expect(
      (within(panel).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled,
    ).toBe(true),
  )
  fireEvent.keyDown(within(panel).getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
  expect(screen.getByRole('group', { name: 'Remove coder' })).toBeDefined()
  release()
})

test('a coding agent removal that finishes after the panel is gone does not navigate', async () => {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const wrapped = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? held.then(() => new Response(null, { status: 204 }))
        : wrapped(input, init),
    ),
  )
  const { router } = open('/b/team/coder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove coder' })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  await router.navigate('/b/team/builder')
  await waitFor(() => expect(screen.queryByRole('group', { name: 'Remove coder' })).toBeNull())
  release()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(router.state.location.pathname).toBe('/b/team/builder')
})

test('an operation that needs attention keeps the page, shows Close, and Escape closes it', async () => {
  stubDelete((call) => {
    if (call.url === '/api/agents/preview') return Response.json(deletePreview())
    if (call.method === 'DELETE') return Response.json(deleteOp('running'), { status: 202 })
    return Response.json({
      ...deleteOp('running'),
      state: 'needs_attention',
      error: 'Hermes did not answer.',
    })
  })
  const { router } = open('/b/team/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  fireEvent.change(await within(panel).findByLabelText('Type builder to confirm'), {
    target: { value: 'builder' },
  })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  const close = await within(panel).findByRole('button', { name: 'Close' })
  await waitFor(() => expect(document.activeElement).toBe(close))
  expect(within(panel).getByText('Hermes did not answer.')).toBeDefined()
  expect(router.state.location.pathname).toBe('/b/team/builder')
  fireEvent.keyDown(close, { key: 'Escape' })
  expect(screen.queryByRole('group', { name: 'Remove builder' })).toBeNull()
})

test('the agent page keeps "needs you" and the overview facts on one row', async () => {
  open('/b/team/builder')
  await screen.findByText('Reports to')
  const row = document.querySelector('.bold-agent-now')
  expect(row?.querySelector('.bold-agent-state')).not.toBeNull()
  expect(row?.querySelector('.bold-agent-facts')).not.toBeNull()
})

test('a capitalised or padded name still confirms, and DELETE carries the exact name (3.7.1)', async () => {
  const calls = stubDelete((call) => {
    if (call.url === '/api/agents/preview')
      return Response.json({
        ...deletePreview(),
        pendingWork: {
          ...deletePreview().pendingWork,
          activeRuns: 0,
          queuedTurns: 0,
          pendingApprovals: 0,
          assignments: 0,
        },
      })
    if (call.method === 'DELETE') return Response.json(deleteOp('running'), { status: 202 })
    return null
  })
  open('/b/team/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  const input = await within(panel).findByLabelText('Type builder to confirm')
  expect(input.getAttribute('autocapitalize')).toBe('none')
  fireEvent.change(input, { target: { value: 'Builde' } })
  expect(within(panel).getByText('That doesn’t match builder.')).toBeDefined()
  fireEvent.change(input, { target: { value: ' Builder ' } })
  const remove = within(panel).getByRole('button', { name: 'Remove' }) as HTMLButtonElement
  expect(remove.disabled).toBe(false)
  fireEvent.click(remove)
  await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true))
  expect(calls.find((call) => call.method === 'DELETE')!.body).toMatchObject({
    typedName: 'builder',
  })
})

test('Stop its work stops a stuck agent and checks again until the work is gone (3.7.1)', async () => {
  let stopped = false
  const calls = stubDelete((call) => {
    if (call.url === '/api/agents/builder/stop-work') {
      stopped = true
      return Response.json({ ok: true })
    }
    if (call.url === '/api/agents/preview')
      return Response.json(
        stopped
          ? {
              ...deletePreview(),
              pendingWork: {
                ...deletePreview().pendingWork,
                activeRuns: 0,
                queuedTurns: 0,
                pendingApprovals: 0,
                assignments: 0,
              },
            }
          : {
              ...deletePreview([
                'Finish active runs, queued turns, pending approvals and unfinished assignments before deleting.',
              ]),
              pendingWork: { ...deletePreview().pendingWork, pendingApprovals: 0, assignments: 0 },
            },
      )
    return null
  })
  open('/b/team/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  fireEvent.click(await within(panel).findByRole('button', { name: 'Stop builder’s work' }))
  await waitFor(() =>
    expect(calls.some((call) => call.url === '/api/agents/builder/stop-work')).toBe(true),
  )
  expect(
    calls.find((call) => call.url === '/api/agents/builder/stop-work')!.headers['idempotency-key'],
  ).toBeTruthy()
  await waitFor(() =>
    expect(
      within(panel).queryByRole('button', { name: /Stop builder’s work|Stopping/ }),
    ).toBeNull(),
  )
  expect(within(panel).queryByRole('alert')).toBeNull()
})
