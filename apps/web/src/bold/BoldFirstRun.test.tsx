import { TeamRoomResponseSchema, type WorkflowList, type WorkflowVersion } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { createStreamQueryRegistry, immediateFrameScheduler } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'
import { BoldFirstRun } from './BoldFirstRun.tsx'
import { FIRST_RUN_DONE_KEY } from './bold-first-run.ts'

type TeamRoomResponse = ReturnType<typeof TeamRoomResponseSchema.parse>

class Source extends EventTarget {
  close() {}
}

const agents = ['lead', 'builder', 'reviewer', 'designer'].map((id) => ({
  id,
  name: id,
  role: `${id} role`,
  style: {
    color: { lead: '#6B4EFF', builder: '#19C39A', reviewer: '#FFB61E', designer: '#FF6B8A' }[
      id as 'lead'
    ]!,
    shape: {
      lead: 'circle-dot',
      builder: 'triangle',
      reviewer: 'diamond',
      designer: 'square',
    }[id as 'lead']!,
  },
  status: 'idle' as const,
  activity: null,
  model: { id: 'fake-model', label: 'Demo model' },
  served: true,
}))

let currentAgents = agents
let currentMembers = agents.map((agent) => agent.id)

const room = (leadAgentId: string | null) => ({
  id: 'team-room',
  name: 'Team room',
  kind: 'room' as const,
  leadAgentId,
  members: currentMembers,
  unread: 0,
  activeAgents: [],
  channels: [],
  role: 'team' as const,
  routing: 'exchanges' as const,
})

const system = (reachable = true, degraded: string[] = []) => ({
  mode: 'fake' as const,
  hermes: {
    version: reachable ? '0.15.2' : null,
    reachable,
    apiServer: reachable,
    capabilities: [],
    servedProfiles: reachable ? ['lead', 'builder', 'reviewer', 'designer'] : [],
  },
  bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' as const },
  compatibility: { fingerprint: 'fake', tested: true, disabled: [] },
  agentIsolation: 'same_user' as const,
  degraded,
})

const workflowList = (names: string[] = []): WorkflowList => ({
  items: names.map((name, index) => ({
    id: `existing-${index}`,
    name,
    description: null,
    latestVersion: 1,
    versionCount: 1,
    used: false,
    agentIds: ['lead'],
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    activeRuns: 0,
    archivedAt: null,
  })),
  inventory: {
    definitions: names.length,
    versions: names.length,
    bytes: 0,
    maxDefinitions: 200,
    maxVersionsPerDefinition: 20,
  },
})

function response(body: unknown, status = 200) {
  return Promise.resolve(Response.json(body, { status }))
}

let calls: { url: string; method: string; body: unknown }[]
let currentSystem = system()
let existingRecipes: string[] = []
let savedLead: string | null = null
let failLeadPatch = false
let workflowListFailures = 0
let failedRecipeNames = new Set<string>()
const disposed: (() => void)[] = []

function installFetch() {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://x')
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      calls.push({ url: `${url.pathname}${url.search}`, method, body })

      if (url.pathname === '/api/agents') return response({ asOfSeq: 1, items: currentAgents })
      if (url.pathname === '/api/team-room')
        return response({
          asOfSeq: 1,
          room: room(savedLead),
          jobs: [],
        } satisfies TeamRoomResponse)
      if (url.pathname === '/api/rooms/team-room/jobs') return response({ asOfSeq: 1, items: [] })
      if (url.pathname === '/api/system') return response(currentSystem)
      if (url.pathname === '/api/about')
        return response({
          version: '1.14.0',
          commit: 'abc1234',
          schema: 42,
          contract: 1,
          hermes: { version: '0.15.2' },
          node: 'v24.0.0',
          mode: 'fake',
          repository: 'https://github.com/kohz87/score',
          checkout: '/home/owner/score',
          service: false,
        })
      if (url.pathname === '/api/workflows' && method === 'GET') {
        if (workflowListFailures > 0) {
          workflowListFailures -= 1
          return response(
            { error: { code: 'unavailable', message: 'Recipes are unavailable.' } },
            503,
          )
        }
        return response(workflowList(existingRecipes))
      }
      if (url.pathname === '/api/workflows' && method === 'POST') {
        const definition = body.definition
        if (failedRecipeNames.has(definition.name))
          return response({ error: { code: 'unavailable', message: 'Save failed.' } }, 503)
        existingRecipes = [...existingRecipes, definition.name]
        return response(
          {
            workflowId: `wf-${existingRecipes.length}`,
            version: 1,
            hash: 'a'.repeat(64),
            createdAt: '2026-10-24T10:00:00.000Z',
            used: false,
            bytes: JSON.stringify(definition).length,
            nodes: definition.nodes.length,
            maxSteps: definition.nodes.length,
            definition,
          } satisfies WorkflowVersion,
          201,
        )
      }
      if (url.pathname === '/api/rooms/team-room' && method === 'PATCH') {
        if (failLeadPatch) return response({ error: { code: 'unavailable', message: 'No.' } }, 503)
        savedLead = body.leadAgentId
        return response(room(savedLead))
      }
      return response({ asOfSeq: 0, items: [] })
    }),
  )
}

function open() {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source as never })
  const queries = createStreamQueryRegistry(queryClient, client, immediateFrameScheduler)
  const router = createMemoryRouter([{ path: '*', element: <BoldFirstRun /> }], {
    initialEntries: ['/b?first=run'],
  })
  disposed.push(() => {
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
  return router
}

beforeEach(() => {
  window.localStorage.clear()
  savedLead = null
  existingRecipes = []
  currentAgents = agents
  currentMembers = agents.map((agent) => agent.id)
  failLeadPatch = false
  workflowListFailures = 0
  failedRecipeNames = new Set()
  currentSystem = system()
  installFetch()
})

afterEach(() => {
  cleanup()
  disposed.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})

test('first run lists the team without pretending members are editable, and never picks a lead', async () => {
  open()

  expect(
    await screen.findByRole('heading', { name: 'Run a team of agents from one room.' }),
  ).toBeDefined()
  expect(screen.getByRole('heading', { name: 'Hermes found' })).toBeDefined()
  expect(
    screen.getByText('Version 0.15.2, gateway running. Bridge waiting for a producer.'),
  ).toBeDefined()

  const members = await screen.findByRole('list', { name: 'Team members' })
  expect(within(members).getAllByRole('listitem')).toHaveLength(4)
  expect(within(members).getByText('builder')).toBeDefined()
  expect(within(members).queryByRole('checkbox')).toBeNull()
  expect(
    screen
      .getByRole('link', { name: 'Add or remove agents on the Team page' })
      .getAttribute('href'),
  ).toBe('/b/team')

  const lead = screen.getByRole('combobox', { name: /Who leads/ }) as HTMLSelectElement
  expect(lead.value).toBe('')
  expect(lead.closest('label')).toBeNull()
  expect(lead.getAttribute('aria-labelledby')).toBe('bold-first-run-lead-title')
  expect(lead.getAttribute('aria-describedby')).toBe('bold-first-run-lead-help')
  expect(screen.getByRole('heading', { name: 'Who leads?' }).getAttribute('id')).toBe(
    'bold-first-run-lead-title',
  )
  expect(
    (screen.getByRole('button', { name: 'Open the team room' }) as HTMLButtonElement).disabled,
  ).toBe(true)

  for (const name of ['Build, then review', 'Write, review, design', 'Research report'])
    expect(
      (screen.getByRole('checkbox', { name: new RegExp(name) }) as HTMLInputElement).disabled,
    ).toBe(false)
  expect(screen.getByText('scripts/score service install')).toBeDefined()
  expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined()
})

test('missing or degraded Hermes says what is wrong and links to the classic setup help', async () => {
  currentSystem = system(false, ['The bridge is out of date.'])
  open()

  expect(await screen.findByRole('heading', { name: 'Hermes not found' })).toBeDefined()
  expect(screen.getByText(/Score can’t reach Hermes on this machine\./)).toBeDefined()
  expect(screen.getByText(/The bridge is out of date\./)).toBeDefined()
  expect(screen.queryByRole('heading', { name: 'Hermes found' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Open the setup help' }).getAttribute('href')).toBe(
    '/b/settings/connections',
  )
})

test('Open saves the lead first, then the chosen recipes, sets the device flag and opens the room', async () => {
  const router = open()
  const lead = (await screen.findByRole('combobox', { name: /Who leads/ })) as HTMLSelectElement
  await waitFor(() => expect(lead.disabled).toBe(false))
  fireEvent.change(lead, {
    target: { value: 'reviewer' },
  })
  fireEvent.click(screen.getByRole('checkbox', { name: /Build, then review/ }))
  fireEvent.click(screen.getByRole('checkbox', { name: /Research report/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Open the team room' }))

  await waitFor(() => expect(router.state.location.pathname).toBe('/b'))
  expect(window.localStorage.getItem(FIRST_RUN_DONE_KEY)).toBe('1')

  const posts = calls.filter((call) => call.url === '/api/workflows' && call.method === 'POST')
  expect(posts).toHaveLength(2)
  expect(
    posts.map((call) => (call.body as { definition: { name: string } }).definition.name),
  ).toEqual(['Build, then review', 'Research report'])
  const patch = calls.find((call) => call.url === '/api/rooms/team-room' && call.method === 'PATCH')
  expect(patch?.body).toEqual({ leadAgentId: 'reviewer' })
  expect(
    calls.findIndex((call) => call.url === '/api/rooms/team-room' && call.method === 'PATCH'),
  ).toBeLessThan(calls.findIndex((call) => call.url === '/api/workflows' && call.method === 'POST'))
})

test('an existing recipe is shown as already saved and is never posted twice', async () => {
  existingRecipes = ['Research report']
  open()

  const existing = (await screen.findByRole('checkbox', {
    name: /Research report/,
  })) as HTMLInputElement
  expect(existing.disabled).toBe(true)
  expect(screen.getByText('Already saved')).toBeDefined()
  fireEvent.click(screen.getByRole('checkbox', { name: /Build, then review/ }))
  const lead = screen.getByRole('combobox', { name: /Who leads/ }) as HTMLSelectElement
  await waitFor(() => expect(lead.disabled).toBe(false))
  fireEvent.change(lead, {
    target: { value: 'builder' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Open the team room' }))
  await waitFor(() =>
    expect(
      calls.filter((call) => call.url === '/api/workflows' && call.method === 'POST'),
    ).toHaveLength(1),
  )
})

test('?first=run pre-selects the lead the team room already has', async () => {
  savedLead = 'reviewer'
  open()

  await waitFor(() =>
    expect((screen.getByRole('combobox', { name: /Who leads/ }) as HTMLSelectElement).value).toBe(
      'reviewer',
    ),
  )
})

test('a workflows-list failure still saves the lead and Retry only retries the chosen recipes', async () => {
  const router = open()
  const lead = (await screen.findByRole('combobox', { name: /Who leads/ })) as HTMLSelectElement
  await waitFor(() => expect(lead.disabled).toBe(false))
  fireEvent.change(lead, {
    target: { value: 'reviewer' },
  })
  fireEvent.click(screen.getByRole('checkbox', { name: /Build, then review/ }))
  workflowListFailures = 1
  fireEvent.click(screen.getByRole('button', { name: 'Open the team room' }))

  expect(await screen.findByText(/Lead saved\. Couldn’t save: Build, then review/)).toBeDefined()
  expect(savedLead).toBe('reviewer')
  expect(window.localStorage.getItem(FIRST_RUN_DONE_KEY)).toBeNull()
  expect(
    calls.filter((call) => call.url === '/api/workflows' && call.method === 'POST'),
  ).toHaveLength(0)
  expect(router.state.location.pathname).toBe('/b')

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(window.localStorage.getItem(FIRST_RUN_DONE_KEY)).toBe('1'))
  expect(
    calls
      .filter((call) => call.url === '/api/workflows' && call.method === 'POST')
      .map((call) => (call.body as { definition: { name: string } }).definition.name),
  ).toEqual(['Build, then review'])
})

test('one recipe failure does not block the others, and the message names only the failed recipe', async () => {
  open()
  const lead = (await screen.findByRole('combobox', { name: /Who leads/ })) as HTMLSelectElement
  await waitFor(() => expect(lead.disabled).toBe(false))
  fireEvent.change(lead, {
    target: { value: 'reviewer' },
  })
  fireEvent.click(screen.getByRole('checkbox', { name: /Build, then review/ }))
  fireEvent.click(screen.getByRole('checkbox', { name: /Write, review, design/ }))
  failedRecipeNames = new Set(['Build, then review'])
  fireEvent.click(screen.getByRole('button', { name: 'Open the team room' }))

  expect(await screen.findByText(/Lead saved\. Couldn’t save: Build, then review/)).toBeDefined()
  expect(screen.queryByText(/Couldn’t save: Build, then review, Write/)).toBeNull()
  expect(savedLead).toBe('reviewer')
  expect(window.localStorage.getItem(FIRST_RUN_DONE_KEY)).toBeNull()
  expect(
    calls
      .filter((call) => call.url === '/api/workflows' && call.method === 'POST')
      .map((call) => (call.body as { definition: { name: string } }).definition.name),
  ).toEqual(['Build, then review', 'Write, review, design'])
})

test('a lead failure saves nothing else and does not set the device flag', async () => {
  open()
  const lead = (await screen.findByRole('combobox', { name: /Who leads/ })) as HTMLSelectElement
  await waitFor(() => expect(lead.disabled).toBe(false))
  fireEvent.change(lead, {
    target: { value: 'reviewer' },
  })
  fireEvent.click(screen.getByRole('checkbox', { name: /Build, then review/ }))
  failLeadPatch = true
  fireEvent.click(screen.getByRole('button', { name: 'Open the team room' }))

  expect(await screen.findByText(/Couldn’t save the lead/)).toBeDefined()
  expect(savedLead).toBeNull()
  expect(window.localStorage.getItem(FIRST_RUN_DONE_KEY)).toBeNull()
  expect(
    calls.filter((call) => call.url === '/api/workflows' && call.method === 'POST'),
  ).toHaveLength(0)
})

test('unmatched recipe roles stay empty and name the step the person must fill', async () => {
  currentMembers = ['captain']
  currentAgents = [
    {
      ...agents[0]!,
      id: 'captain',
      name: 'captain',
      role: 'Coordinates the work',
    },
  ]
  savedLead = 'captain'
  open()

  const lead = (await screen.findByRole('combobox', { name: /Who leads/ })) as HTMLSelectElement
  await waitFor(() => expect(lead.disabled).toBe(false))
  expect(
    await screen.findAllByText('You pick the agent for build it in the recipe editor'),
  ).toHaveLength(1)
  expect(screen.getByText('You pick the agent for review it in the recipe editor')).toBeDefined()
  expect(
    screen.getByText('You pick the agent for review the draft in the recipe editor'),
  ).toBeDefined()
  expect(
    screen.getByText('You pick the agent for draw the image in the recipe editor'),
  ).toBeDefined()
  expect(screen.queryByText('You pick the agent for research in the recipe editor')).toBeNull()
})
