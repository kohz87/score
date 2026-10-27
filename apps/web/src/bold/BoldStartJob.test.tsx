import { ORCH_ACKNOWLEDGEMENT_TEXT, type AgentSummary } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { App, appRoutes } from '../App.tsx'
import { createQueryClient, StreamContext } from '../data/query-client.ts'
import { immediateFrameScheduler, createStreamQueryRegistry } from '../data/resync.ts'
import { createStreamClient } from '../data/stream.ts'

// PLAN 11.10c: the Start a job dialog's form states, its checklist and the one-time trigger secret.

const agents: AgentSummary[] = [
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

const iso = '2026-10-24T09:00:00.000Z'
const room = {
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
const workflow = {
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
}
const routine = {
  id: 'lead:nightly',
  title: 'Nightly build check',
  schedule: 'Every weekday at 9:00',
  description: 'Check the build.',
  lastRunAt: null,
  enabled: true,
}
const workflowPreflight = {
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

let preflightFails = false
/** 3.7.9: the lead's tool list; after a reload the next preflight reports it ok. */
let toolsListed: 'unknown' | 'ok' | null = null
let reloads: string[] = []
/** 3.7.5: a coding agent leading the room (null: the fixture's `lead`). */
let codingLead: string | null = null
let workflowPreflightNow: unknown = workflowPreflight
let workflowRunBodies: Record<string, unknown>[] = []
let workflowRunReply: () => Response = () =>
  Response.json({ error: { code: 'internal', message: 'no' } }, { status: 500 })
let triggerBody: unknown
const disposers: (() => void)[] = []

beforeEach(() => {
  preflightFails = false
  workflowPreflightNow = workflowPreflight
  workflowRunBodies = []
  workflowRunReply = () =>
    Response.json({ error: { code: 'internal', message: 'no' } }, { status: 500 })
  triggerBody = undefined
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
          items: codingLead
            ? [...agents, { ...agents[1]!, id: codingLead, name: codingLead, runtime: 'codex' }]
            : agents,
        })
      if (url.pathname === '/api/approvals') return json({ asOfSeq: 1, items: [] })
      if (url.pathname === '/api/team-room')
        return json({
          asOfSeq: 1,
          room: { ...room, leadAgentId: codingLead ?? room.leadAgentId },
          jobs: [],
        })
      if (url.pathname === '/api/workflows')
        return json({
          items: [workflow],
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
      if (url.pathname === '/api/workflow-runs/preflight') return json(workflowPreflightNow)
      if (url.pathname === '/api/workflow-runs' && method === 'POST') {
        workflowRunBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Promise.resolve(workflowRunReply())
      }
      if (url.pathname === '/api/orchestrations/preflight') {
        const check = orchestrationCheck(!preflightFails)
        if (toolsListed)
          check.checks.push({
            id: 'tool_readiness',
            status: toolsListed,
            message:
              toolsListed === 'ok'
                ? 'The lead sees every orch.* tool'
                : "The lead's Hermes hasn't asked Score for its tools",
          })
        return json(check)
      }
      if (url.pathname === '/api/agents/lead/mcp/reload' && method === 'POST') {
        reloads.push('lead')
        toolsListed = 'ok'
        return json({ agentId: 'lead', scope: 'profile' })
      }
      if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/routines'))
        return json({ items: url.pathname.includes('/agents/lead/') ? [routine] : [] })
      if (url.pathname === '/api/triggers' && method === 'POST') {
        triggerBody = JSON.parse(String(init?.body))
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
  return router
}

async function startDialog() {
  return screen.findByRole('dialog', { name: 'Start a job' })
}

function acknowledgement(dialog: HTMLElement) {
  return within(dialog).getByRole('checkbox', { name: /Score controls the work it starts/ })
}

test('?start=job and the room button open the dialog, and the checklist protects Start', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  expect(dialog.getAttribute('data-protected')).toBe('block')
  expect(dialog.hasAttribute('data-decision')).toBe(true)
  const checks = within(dialog).getByRole('region', { name: 'Before it starts' })
  expect(checks.getAttribute('data-protected')).toBe('block')
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  expect(start.hasAttribute('disabled')).toBe(true)

  fireEvent.change(within(dialog).getByLabelText('What should the team do?'), {
    target: { value: 'Write the release notes' },
  })
  expect(start.hasAttribute('disabled')).toBe(true)
  fireEvent.click(acknowledgement(dialog))
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))

  // A filled-in form asks before it is thrown away.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Discard' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start a job' })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Start a job' }))
  expect(await startDialog()).toBeDefined()
})

test('the recipe, When and required inputs each block and then unblock Start', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  fireEvent.change(within(dialog).getByLabelText('What should the team do?'), {
    target: { value: 'Write the release notes' },
  })
  fireEvent.click(acknowledgement(dialog))
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  expect(within(dialog).getByText('Agents allowed')).toBeDefined()

  fireEvent.click(within(dialog).getByRole('radio', { name: 'None' }))
  expect(within(dialog).queryByText('Agents allowed')).toBeNull()
  await waitFor(() =>
    expect(within(dialog).getByText('The job opens in the team room')).toBeDefined(),
  )

  // A schedule runs as a routine of the lead: the recipe choice goes away and Start stays open.
  fireEvent.click(within(dialog).getByRole('radio', { name: 'On a schedule' }))
  expect(within(dialog).getByRole('combobox', { name: 'Schedule' })).toBeDefined()
  expect(within(dialog).queryByRole('radiogroup', { name: 'Recipe' })).toBeNull()
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))

  fireEvent.click(within(dialog).getByRole('radio', { name: 'Now, once' }))
  fireEvent.click(within(dialog).getByRole('radio', { name: 'lead decides' }))
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))

  fireEvent.click(within(dialog).getByRole('radio', { name: 'Release recipe' }))
  fireEvent.click(within(dialog).getByRole('radio', { name: 'Now, once' }))
  await waitFor(() => expect(within(dialog).getByText(/version 1/)).toBeDefined())
  expect(start.hasAttribute('disabled')).toBe(true)
  expect(within(dialog).getByText('Fill in Topic')).toBeDefined()
  fireEvent.change(within(dialog).getByLabelText(/^Topic/), { target: { value: '2.4' } })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
})

test('existing routines are listed as scheduled jobs', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  const scheduled = await within(dialog).findByRole('region', { name: 'Scheduled' })
  expect(scheduled.textContent).toContain('Nightly build check')
  expect(scheduled.textContent).toContain('lead · Every weekday at 9:00')
})

test('a failed preflight check keeps Start disabled and names the problem', async () => {
  preflightFails = true
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.change(within(dialog).getByLabelText('What should the team do?'), {
    target: { value: 'Write the release notes' },
  })
  fireEvent.click(acknowledgement(dialog))
  await waitFor(() => expect(within(dialog).getByText('Hermes is not reachable')).toBeDefined())
  expect(
    within(dialog).getByRole('button', { name: 'Start the job' }).hasAttribute('disabled'),
  ).toBe(true)
})

test('a trigger created by the dialog shows its address and secret once, in a protected card', async () => {
  open('/b?start=job')
  const dialog = await startDialog()
  fireEvent.change(within(dialog).getByLabelText('What should the team do?'), {
    target: { value: 'Write the release notes' },
  })
  fireEvent.click(acknowledgement(dialog))
  fireEvent.click(within(dialog).getByRole('radio', { name: 'When another app calls' }))
  fireEvent.change(within(dialog).getByLabelText('Trigger name'), {
    target: { value: 'New lead' },
  })
  fireEvent.change(within(dialog).getByLabelText('The app it comes from'), {
    target: { value: 'Tickets' },
  })
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  fireEvent.click(start)

  expect(await screen.findByRole('heading', { name: 'Trigger created' })).toBeDefined()
  const secret = document.querySelector('.start-secret') as HTMLElement
  expect(secret.getAttribute('data-protected')).toBe('block')
  expect(secret.textContent).toContain('https://score.test/hooks/trg_unit')
  expect(secret.textContent).toContain('whsec_unit_secret')
  expect(triggerBody).toMatchObject({
    name: 'New lead',
    app: 'Tickets',
    mapping: { ref: 'ref', title: 'title', link: 'link', details: 'details' },
    template: 'Write the release notes',
    reportBack: { mode: 'off' },
  })

  // The room behind the dialog has its own D10 "Done" filter; this is the result's Done.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start a job' })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Start a job' }))
  const reopened = await startDialog()
  expect(within(reopened).queryByText('whsec_unit_secret')).toBeNull()
})

const codingWorker = (policyId: string, reach: boolean) => ({
  agentId: 'coder-a',
  runtime: 'codex',
  readiness: 'ready',
  detail: null,
  policyId,
  reach: 'Reads any file you can read, not only the ones in /work/site.',
  reachBeyondWorkspace: reach,
})

async function recipeDialog() {
  open('/b?start=job&recipe=wf_release')
  const dialog = await startDialog()
  await waitFor(() =>
    expect(within(dialog).getByRole('radio', { name: 'Release recipe' })).toBeDefined(),
  )
  return dialog
}

test('a recipe says that a spend cap pauses a step whose cost is unknown', async () => {
  const dialog = await recipeDialog()
  expect(
    within(dialog).getByText(/a step whose cost Hermes doesn’t report pauses the run/),
  ).toBeDefined()
  fireEvent.change(within(dialog).getByLabelText(/^Spend cap/), { target: { value: '0' } })
  await waitFor(() =>
    expect(
      within(dialog).queryByText(/a step whose cost Hermes doesn’t report pauses the run/),
    ).toBeNull(),
  )
})

test('a coding recipe asks for its reach, and More options reach the posted body', async () => {
  workflowPreflightNow = {
    ...workflowPreflight,
    workers: [codingWorker('a'.repeat(64), true)],
    defaults: { ...workflowPreflight.defaults, codingSteps: 4 },
  }
  const dialog = await recipeDialog()
  fireEvent.change(within(dialog).getByLabelText(/Topic|Release/i, { selector: 'textarea' }), {
    target: { value: 'the 2.4 release' },
  })
  fireEvent.click(acknowledgement(dialog))
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  const reach = await within(dialog).findByRole('checkbox', {
    name: /I understand what these coding agents can read/,
  })
  expect(
    within(dialog)
      .getByText(/Coding agents in this job/)
      .closest('[data-protected]'),
  ).not.toBeNull()
  expect(start.hasAttribute('disabled')).toBe(true)

  fireEvent.click(within(dialog).getByText('More options'))
  expect((within(dialog).getByLabelText('Most coding steps') as HTMLInputElement).value).toBe('4')
  fireEvent.change(within(dialog).getByLabelText('Most coding steps'), { target: { value: '6' } })
  fireEvent.change(within(dialog).getByLabelText(/^Quota floor/), { target: { value: '20' } })
  fireEvent.change(within(dialog).getByLabelText(/^Steps at the same time/), {
    target: { value: '3' },
  })
  fireEvent.change(within(dialog).getByLabelText(/^Estimate per step/), {
    target: { value: '0.75' },
  })
  expect(start.hasAttribute('disabled')).toBe(true)
  fireEvent.click(reach)
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  fireEvent.click(start)
  await waitFor(() => expect(workflowRunBodies).toHaveLength(1))
  expect(workflowRunBodies[0]).toMatchObject({
    workflowId: 'wf_release',
    codingPolicies: { 'coder-a': 'a'.repeat(64) },
    acknowledgeCodingReach: { policyIds: ['a'.repeat(64)] },
    codingSteps: 6,
    quotaFloorPercent: 20,
    maxConcurrentSteps: 3,
    stepEstimateUsd: 0.75,
  })
})

test('a coding agent whose policy changed has to be accepted again', async () => {
  workflowPreflightNow = { ...workflowPreflight, workers: [codingWorker('a'.repeat(64), true)] }
  workflowRunReply = () =>
    Response.json({ error: { code: 'policy_changed', message: 'changed' } }, { status: 409 })
  const dialog = await recipeDialog()
  fireEvent.change(within(dialog).getByLabelText(/Topic|Release/i, { selector: 'textarea' }), {
    target: { value: 'x' },
  })
  fireEvent.click(acknowledgement(dialog))
  fireEvent.click(
    await within(dialog).findByRole('checkbox', {
      name: /I understand what these coding agents can read/,
    }),
  )
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  workflowPreflightNow = { ...workflowPreflight, workers: [codingWorker('b'.repeat(64), true)] }
  fireEvent.click(start)
  await waitFor(() => expect(workflowRunBodies).toHaveLength(1))
  await waitFor(() =>
    expect(
      (
        within(dialog).getByRole('checkbox', {
          name: /I understand what these coding agents can read/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false),
  )
  expect(
    within(dialog).getByRole('button', { name: 'Start the job' }).hasAttribute('disabled'),
  ).toBe(true)
})

test('More options are range-checked: an empty or out-of-range field blocks Start and says why', async () => {
  workflowPreflightNow = {
    ...workflowPreflight,
    workers: [codingWorker('a'.repeat(64), false)],
    defaults: { ...workflowPreflight.defaults, codingSteps: 4 },
  }
  const dialog = await recipeDialog()
  fireEvent.change(within(dialog).getByLabelText(/Topic|Release/i, { selector: 'textarea' }), {
    target: { value: 'x' },
  })
  fireEvent.click(acknowledgement(dialog))
  const start = within(dialog).getByRole('button', { name: 'Start the job' })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  fireEvent.click(within(dialog).getByText('More options'))

  const cases: [RegExp, string[], string, RegExp][] = [
    [/^Steps at the same time/, ['0', '4', ''], '2', /Steps at the same time must be 1 to 3/],
    [/^Estimate per step/, ['0', '1001', ''], '0.5', /Estimate per step must be above 0/],
    [/^Most coding steps/, ['0', '999', ''], '4', /Most coding steps must be 1 to/],
  ]
  for (const [label, bad, good, reason] of cases) {
    for (const value of bad) {
      fireEvent.change(within(dialog).getByLabelText(label), { target: { value } })
      await waitFor(() => expect(start.hasAttribute('disabled')).toBe(true))
      expect(within(dialog).getByText(reason)).toBeDefined()
    }
    fireEvent.change(within(dialog).getByLabelText(label), { target: { value: good } })
    await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  }
})

test('an agent being set up, deleted or removed is never offered in Agents allowed', async () => {
  const extra: AgentSummary[] = (['setting_up', 'deleting', 'removed'] as const).map((state) => ({
    ...agents[1]!,
    id: `gone-${state}`,
    name: `gone-${state}`,
    lifecycle: { state, incarnationId: '6f9619ff-8b86-4d11-b42d-00c04fc964ff', operationId: null },
  }))
  agents.push(...extra)
  try {
    open('/b?start=job')
    const dialog = await startDialog()
    const picker = await within(dialog).findByRole('group', { name: 'Agents allowed' })
    await waitFor(() => expect(picker.textContent).toContain('builder'))
    for (const agent of extra) expect(picker.textContent).not.toContain(agent.name)
  } finally {
    agents.splice(agents.length - extra.length, extra.length)
  }
})

test('in a room a coding agent leads, “lead decides” asks which Hermes agent plans it (3.7.5)', async () => {
  codingLead = 'coder'
  try {
    open('/b?start=job')
    const dialog = await startDialog()
    const planner = await within(dialog).findByLabelText('Who plans it')
    expect(
      within(dialog).getByText(/coder leads this room, but a coding agent can’t plan/),
    ).toBeDefined()
    const options = within(planner)
      .getAllByRole('option')
      .map((option) => option.textContent)
    expect(options).not.toContain('coder')
    expect(options).toContain('builder')
    fireEvent.change(planner, { target: { value: 'builder' } })
    expect((planner as HTMLSelectElement).value).toBe('builder')
    // The planner leaves the steps' agents; the coding room lead can still take steps.
    const pick = within(dialog).getByRole('group', { name: 'Agents allowed' })
    expect(within(pick).queryByRole('checkbox', { name: /builder/ })).toBeNull()
    expect(within(pick).getByRole('checkbox', { name: /coder/ })).toBeDefined()
  } finally {
    codingLead = null
  }
})

test('the tool check offers Reload MCP, asks first, restarts the lead’s gateway and checks again (3.7.9)', async () => {
  toolsListed = 'unknown'
  reloads = []
  try {
    open('/b?start=job')
    const dialog = await startDialog()
    const checks = within(dialog).getByRole('region', { name: 'Before it starts' })
    fireEvent.click(await within(checks).findByRole('button', { name: 'Reload MCP' }))
    expect(within(checks).getByText(/This restarts lead’s Hermes/)).toBeDefined()
    expect(reloads).toEqual([])
    fireEvent.click(within(checks).getByRole('button', { name: 'Restart and reload' }))
    await waitFor(() => expect(reloads).toEqual(['lead']))
    await waitFor(() =>
      expect(within(checks).getByText('The lead sees every orch.* tool')).toBeDefined(),
    )
    expect(within(checks).queryByRole('button', { name: 'Reload MCP' })).toBeNull()
  } finally {
    toolsListed = null
  }
})
