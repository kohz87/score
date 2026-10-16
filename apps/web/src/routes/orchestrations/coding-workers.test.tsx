import { ORCH_ACKNOWLEDGEMENT_TEXT } from '@score/contract'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  orchestrationEvents,
  orchestrationFixtures,
} from '../../../../../e2e/orchestration-fixtures.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { NewOrchestrationDialog } from './NewOrchestrationDialog.tsx'
import { OrchestrationLive } from './OrchestrationLive.tsx'

// 7.7b-3: coding agents as workers in the browser: the start dialog (reach acknowledged by policy id, unknown cost per
// source, the coding step limit), the CLI badge, and the two blocked-step actions.

class Source extends EventTarget {
  close() {}
}
const hexA = 'a'.repeat(64)
const hexB = 'b'.repeat(64)
const agents = [
  { id: 'lead', name: 'lead', style: { color: '#6B4EFF', shape: 'circle-dot' }, status: 'idle' },
  { id: 'builder', name: 'builder', style: { color: '#19C39A', shape: 'square' }, status: 'idle' },
  {
    id: 'reviewer',
    name: 'reviewer',
    style: { color: '#FFB61E', shape: 'triangle' },
    status: 'idle',
    runtime: 'claude-code',
  },
  {
    id: 'designer',
    name: 'designer',
    style: { color: '#FF6B8A', shape: 'diamond' },
    status: 'idle',
    runtime: 'codex',
  },
]
const base = {
  ok: true,
  checks: [{ id: 'listener', status: 'ok', message: 'The loopback MCP listener is up' }],
  gatePolicyNotes: { 'every-step': 'a', 'lead-asks': 'b', none: 'c' },
  acknowledgementText: ORCH_ACKNOWLEDGEMENT_TEXT,
  defaults: {
    maxSteps: 12,
    maxLeadTurns: 20,
    maxConcurrentSteps: 2,
    leadTurnEstimateUsd: 0.25,
    stepEstimateUsd: 0.5,
    codingSteps: 10,
  },
  reserveBytes: 100,
}
const worker = (patch: Record<string, unknown>) => ({
  agentId: 'designer',
  runtime: 'codex',
  readiness: 'ready',
  detail: null,
  policyId: hexA,
  reach: 'Reads any file you can read, not only the ones in /work/site. It can’t change files.',
  reachBeyondWorkspace: true,
  ...patch,
})
let preflight: Record<string, unknown>
let requests: { url: string; init?: RequestInit }[]
let post: (url: string, init?: RequestInit) => Response | undefined
const dispose: (() => void)[] = []
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

beforeEach(() => {
  requests = []
  preflight = { ...base, workers: [worker({})] }
  post = () => undefined
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
      const url = String(input)
      requests.push({ url, ...(init ? { init } : {}) })
      if ((init?.method ?? 'GET') === 'POST') {
        const custom = post(url, init)
        if (custom) return Promise.resolve(custom)
      }
      if (url === '/api/agents')
        return Promise.resolve(
          json({
            asOfSeq: 1,
            items: agents.map((agent) => ({
              role: '',
              activity: null,
              model: null,
              served: true,
              ...agent,
            })),
          }),
        )
      if (url === '/api/orchestrations/orch-1/events')
        return Promise.resolve(json(orchestrationEvents))
      if (url.startsWith('/api/orchestrations/preflight')) return Promise.resolve(json(preflight))
      const fixture = orchestrationFixtures[url]
      return Promise.resolve(
        fixture === undefined
          ? json({ error: { code: 'not_found', message: 'none' } }, 404)
          : json(fixture),
      )
    }),
  )
})
afterEach(() => {
  cleanup()
  dispose.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
})

function mount(ui: React.ReactElement) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source as never })
  const queries = createStreamQueryRegistry(queryClient, client)
  dispose.push(() => {
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

async function openDialog(pick: string) {
  mount(<NewOrchestrationDialog agents={agents as never} close={() => {}} created={vi.fn()} />)
  const dialog = await screen.findByRole('dialog', { name: 'New orchestration' })
  fireEvent.change(within(dialog).getByLabelText('Goal'), { target: { value: 'Ship it' } })
  fireEvent.click(within(dialog).getByRole('checkbox', { name: new RegExp(pick) }))
  fireEvent.click(within(dialog).getByLabelText(/Score controls the work it starts/))
  return dialog
}
const startButton = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: 'Start orchestration' }) as HTMLButtonElement
const createBody = () =>
  JSON.parse(
    String(
      requests.find((r) => r.url === '/api/orchestrations' && r.init?.method === 'POST')!.init!
        .body,
    ),
  ) as Record<string, unknown>

test('only Hermes agents can lead; a coding agent is offered as a worker with its program named', async () => {
  const dialog = await openDialog('designer')
  const lead = within(dialog).getByRole('combobox', { name: 'Lead' })
  expect(
    within(lead)
      .getAllByRole('option')
      .map((o) => o.textContent),
  ).toEqual(['lead', 'builder'])
  expect(within(dialog).getAllByText('Codex').length).toBeGreaterThan(0)
})

test('a worker that reads beyond its workspace needs one acknowledgement, sent by policy id', async () => {
  post = () => json({ error: { code: 'x', message: 'stop here' } }, 500)
  const dialog = await openDialog('designer')
  const section = await within(dialog).findByRole('region', { name: 'Coding agents in this run' })
  expect(within(section).getByText(/Reads any file you can read/)).toBeTruthy()
  expect(within(section).getByText(/Whatever a coding agent can read, it can repeat/)).toBeTruthy()
  // Not accepted yet: the dialog can't start.
  expect(startButton(dialog).disabled).toBe(true)
  fireEvent.click(
    within(section).getByRole('checkbox', {
      name: /I understand what these coding agents can read/,
    }),
  )
  await waitFor(() => expect(startButton(dialog).disabled).toBe(false))
  fireEvent.change(within(dialog).getByLabelText('Most coding steps'), { target: { value: '4' } })
  fireEvent.click(within(dialog).getByLabelText(/Keep going when the cost of Codex is unknown/))
  fireEvent.click(startButton(dialog))
  await waitFor(() => expect(requests.some((r) => r.init?.method === 'POST')).toBe(true))
  expect(createBody()).toMatchObject({
    allowedAgents: ['designer'],
    codingPolicies: { designer: hexA },
    acknowledgeCodingReach: { policyIds: [hexA] },
    codingSteps: 4,
    acceptUnknownCost: ['codex'],
  })
})

test('a worker that stays in its workspace needs no acknowledgement', async () => {
  preflight = {
    ...base,
    workers: [
      worker({
        agentId: 'reviewer',
        runtime: 'claude-code',
        reach: 'Reads and edits files in /work/site.',
        reachBeyondWorkspace: false,
      }),
    ],
  }
  post = () => json({ error: { code: 'x', message: 'stop here' } }, 500)
  const dialog = await openDialog('reviewer')
  const section = await within(dialog).findByRole('region', { name: 'Coding agents in this run' })
  expect(within(section).queryByRole('checkbox')).toBeNull()
  await waitFor(() => expect(startButton(dialog).disabled).toBe(false))
  fireEvent.click(startButton(dialog))
  await waitFor(() => expect(requests.some((r) => r.init?.method === 'POST')).toBe(true))
  const body = createBody()
  expect(body['codingPolicies']).toEqual({ reviewer: hexA })
  expect(body['acknowledgeCodingReach']).toBeUndefined()
})

test('a worker that isn’t ready says why in plain words and blocks the start', async () => {
  preflight = {
    ...base,
    ok: false,
    workers: [worker({ readiness: 'version_untested', detail: null, policyId: null, reach: null })],
  }
  const dialog = await openDialog('designer')
  const section = await within(dialog).findByRole('region', { name: 'Coding agents in this run' })
  expect(within(section).getByText(/hasn’t tested this version/)).toBeTruthy()
  expect(startButton(dialog).disabled).toBe(true)
})

test('an acknowledgement never carries over to a changed policy id', async () => {
  post = () =>
    json(
      { error: { code: 'policy_changed', message: 'changed', details: { agentId: 'designer' } } },
      409,
    )
  const dialog = await openDialog('designer')
  const section = await within(dialog).findByRole('region', { name: 'Coding agents in this run' })
  const accept = within(section).getByRole('checkbox', {
    name: /I understand what these coding agents can read/,
  })
  fireEvent.click(accept)
  await waitFor(() => expect(startButton(dialog).disabled).toBe(false))
  // The agent changes: the next preflight names another policy.
  preflight = { ...base, workers: [worker({ policyId: hexB })] }
  fireEvent.click(startButton(dialog))
  await within(dialog).findByText(/A coding agent changed since you looked/)
  await waitFor(() =>
    expect(
      (
        within(dialog).getByRole('checkbox', {
          name: /I understand what these coding agents can read/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false),
  )
  expect(startButton(dialog).disabled).toBe(true)
})

test('a refused check explains itself and blocks the start', async () => {
  const get = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).getMockImplementation() as (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith('/api/orchestrations/preflight')
        ? Promise.resolve(
            json(
              {
                error: {
                  code: 'coding_workers_need_units',
                  message:
                    'Coding agents can take steps only where Score runs them as system services.',
                },
              },
              422,
            ),
          )
        : get(input, init),
    ),
  )
  const dialog = await openDialog('designer')
  await within(dialog).findByText(/only where Score runs them as system services/)
  expect(startButton(dialog).disabled).toBe(true)
})

type Snapshot = {
  orchestration: { needsYou: unknown[]; coding?: unknown }
}
async function withSnapshot(
  needsYou: unknown[],
  run: () => Promise<void>,
  coding: unknown = {
    stepLimit: 3,
    acceptedUnknownCost: [],
    workers: [
      {
        agentId: 'reviewer',
        runtime: 'claude-code',
        policyId: hexA,
        reach: 'Reads and edits files in /work/site.',
        reachBeyondWorkspace: false,
      },
    ],
  },
) {
  const snapshot = orchestrationFixtures['/api/orchestrations/orch-1'] as Snapshot
  const original = snapshot.orchestration.needsYou
  snapshot.orchestration.needsYou = [...original, ...needsYou]
  snapshot.orchestration.coding = coding
  post = () => json((orchestrationFixtures['/api/orchestrations'] as { items: unknown[] }).items[0])
  try {
    await run()
  } finally {
    snapshot.orchestration.needsYou = original
    delete snapshot.orchestration.coding
  }
}

test('the diagram names the program of a coding agent next to its name', async () => {
  await withSnapshot([], async () => {
    mount(<OrchestrationLive orchestrationId="orch-1" />)
    await screen.findByRole('log', { name: 'Events' })
    expect(
      await screen.findByRole('button', { name: /Step s2, reviewer \(Claude Code\), running/ }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: /Step s1, builder, succeeded/ })).toBeTruthy()
    // The log tags the lines about a coding agent's step too.
    expect(
      within(screen.getByRole('log', { name: 'Events' })).getAllByText('Claude Code').length,
    ).toBeGreaterThan(0)
  })
})

test('"agent changed" offers the new settings: a policy-only remap carrying the policy id and the acknowledgement', async () => {
  preflight = {
    ...base,
    workers: [worker({ agentId: 'reviewer', runtime: 'claude-code', policyId: hexB })],
  }
  await withSnapshot(
    [{ kind: 'policy_changed', stepId: 's2', agentId: 'reviewer', currentPolicyId: hexB }],
    async () => {
      mount(<OrchestrationLive orchestrationId="orch-1" />)
      const card = await screen.findByRole('region', { name: 'New settings for reviewer' })
      const button = await within(card).findByRole('button', { name: 'Use the new settings' })
      // It reads beyond its workspace now: accept that first.
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true))
      fireEvent.click(
        within(card).getByRole('checkbox', { name: /I understand what it can read now/ }),
      )
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(button)
      await waitFor(() =>
        expect(requests.some((r) => r.url.endsWith('/orch-1/steps/s2/remap'))).toBe(true),
      )
      const request = requests.find((r) => r.url.endsWith('/orch-1/steps/s2/remap'))!
      expect(JSON.parse(String(request.init?.body))).toEqual({
        agentId: 'reviewer',
        policyId: hexB,
        acknowledgeCodingReach: { policyIds: [hexB] },
        orchestrationRevision: 9,
      })
    },
  )
})

test('"limit reached" offers to raise the number of coding steps', async () => {
  await withSnapshot([{ kind: 'coding_limit', stepId: 's2' }], async () => {
    mount(<OrchestrationLive orchestrationId="orch-1" />)
    const card = await screen.findByRole('region', { name: 'Coding step limit' })
    expect(within(card).getByText(/up to 3 coding steps/)).toBeTruthy()
    fireEvent.change(within(card).getByLabelText(/New limit/), { target: { value: '9' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Raise the limit and continue' }))
    await waitFor(() => expect(requests.some((r) => r.url.endsWith('/orch-1/limits'))).toBe(true))
    const request = requests.find((r) => r.url.endsWith('/orch-1/limits'))!
    expect(JSON.parse(String(request.init?.body))).toEqual({
      orchestrationRevision: 9,
      codingSteps: 9,
    })
  })
})

test('unknown spend can be accepted for one source', async () => {
  await withSnapshot([{ kind: 'budget', reason: 'unknown_spend' }], async () => {
    mount(<OrchestrationLive orchestrationId="orch-1" />)
    const card = await screen.findByRole('region', { name: 'Budget or deadline' })
    fireEvent.click(
      within(card).getByRole('button', { name: 'Continue although Claude Code cost is unknown' }),
    )
    await waitFor(() => expect(requests.some((r) => r.url.endsWith('/orch-1/limits'))).toBe(true))
    const request = requests.find((r) => r.url.endsWith('/orch-1/limits'))!
    expect(JSON.parse(String(request.init?.body))).toEqual({
      orchestrationRevision: 9,
      acceptUnknownCost: { add: ['claude-code'] },
    })
  })
})

test('the compact dialog (user view) keeps the goal, agents, budget and the safety questions, with defaults for the rest', async () => {
  post = () => json({ error: { code: 'x', message: 'stop here' } }, 500)
  mount(
    <NewOrchestrationDialog
      compact
      initialGoal="Plan the launch"
      agents={agents as never}
      close={() => {}}
      created={vi.fn()}
    />,
  )
  const dialog = await screen.findByRole('dialog', { name: 'New orchestration' })
  expect((within(dialog).getByLabelText('Goal') as HTMLTextAreaElement).value).toBe(
    'Plan the launch',
  )
  expect(within(dialog).getByLabelText('Budget in USD (optional)')).toBeTruthy()
  // What the full dialog also asks is left out.
  expect(within(dialog).queryByText('Approvals')).toBeNull()
  expect(within(dialog).queryByLabelText('Deadline (optional)')).toBeNull()
  expect(within(dialog).queryByText('Limits and estimates')).toBeNull()
  // A coding agent still brings the reach acknowledgement and the unknown-cost question.
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /designer/ }))
  fireEvent.click(within(dialog).getByLabelText(/Score controls the work it starts/))
  const section = await within(dialog).findByRole('region', { name: 'Coding agents in this run' })
  expect(startButton(dialog).disabled).toBe(true)
  fireEvent.click(
    within(section).getByRole('checkbox', {
      name: /I understand what these coding agents can read/,
    }),
  )
  expect(within(dialog).getByLabelText(/Keep going when the cost of Codex is unknown/)).toBeTruthy()
  await waitFor(() => expect(startButton(dialog).disabled).toBe(false))
  fireEvent.click(startButton(dialog))
  await waitFor(() => expect(requests.some((r) => r.init?.method === 'POST')).toBe(true))
  expect(createBody()).toMatchObject({
    goal: 'Plan the launch',
    gatePolicy: 'every-step',
    maxSteps: 12,
    acknowledgeCodingReach: { policyIds: [hexA] },
  })
})
