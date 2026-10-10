import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  orchestrationEvents,
  orchestrationFixtures,
  orchestrationSnapshot,
} from '../../../../../e2e/orchestration-fixtures.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { NewOrchestrationDialog } from './NewOrchestrationDialog.tsx'
import { OrchestrationLive } from './OrchestrationLive.tsx'

class Source extends EventTarget {
  static current: Source
  constructor() {
    super()
    Source.current = this
  }
  close() {}
}
const agents = [
  { id: 'lead', name: 'lead', style: { color: '#6B4EFF', shape: 'circle-dot' }, status: 'idle' },
  { id: 'builder', name: 'builder', style: { color: '#19C39A', shape: 'square' }, status: 'idle' },
  {
    id: 'reviewer',
    name: 'reviewer',
    style: { color: '#FFB61E', shape: 'triangle' },
    status: 'idle',
  },
  {
    id: 'designer',
    name: 'designer',
    style: { color: '#FF6B8A', shape: 'diamond' },
    status: 'idle',
  },
]
const preflight = {
  ok: true,
  checks: [
    { id: 'listener', status: 'ok', message: 'The loopback MCP listener is up' },
    {
      id: 'tool_readiness',
      status: 'unknown',
      message: 'Hermes loads MCP tools per session; Score cannot see whether the lead has them',
    },
  ],
  gatePolicyNotes: {
    'every-step': 'Every step waits for you.',
    'lead-asks': 'Steps start unless the lead asks you first.',
    none: 'Steps start at once.',
  },
  acknowledgementText:
    "Score controls the work it starts (turns and steps) and can stop those runs; agents may still use other tools and start background work Score can't see or stop.",
  defaults: {
    maxSteps: 12,
    maxLeadTurns: 20,
    maxConcurrentSteps: 2,
    leadTurnEstimateUsd: 0.25,
    stepEstimateUsd: 0.5,
  },
  reserveBytes: 100,
}
let requests: { url: string; init?: RequestInit }[]
let events: unknown
let post: (url: string, init?: RequestInit) => Response | undefined
const dispose: (() => void)[] = []
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

beforeEach(() => {
  requests = []
  events = orchestrationEvents
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
      if (url === '/api/agents') return Promise.resolve(json({ asOfSeq: 1, items: agents }))
      if (url === '/api/orchestrations/orch-1/events') return Promise.resolve(json(events))
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
  const client = createStreamClient({ EventSourceImpl: Source })
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
  return { queryClient }
}

test('the live page shows each step in its state, the gate with its frozen assignment, and the full log', async () => {
  mount(<OrchestrationLive orchestrationId="orch-1" />)
  await screen.findByRole('log', { name: 'Events' })
  expect(screen.getByRole('button', { name: /Step s1, builder, succeeded/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Step s2, reviewer, running/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /Step s3, designer, needs you/ })).toBeTruthy()
  const gate = screen.getByRole('region', { name: 'Approve s3' })
  expect(within(gate).getByText('Design a announcement image for the release.')).toBeTruthy()
  expect(within(gate).getByText(/s1 \(result v1, succeeded\)/)).toBeTruthy()
  // Score's verdict on a refused call is in the log.
  expect(within(screen.getByRole('log')).getByText(/agent_not_allowed/)).toBeTruthy()
  // Budget fields: settled, provisional, reserved, completeness; estimates are per turn and per step.
  expect(screen.getByText(/some attempts are not settled yet/)).toBeTruthy()
  expect(screen.getByText(/per lead turn/)).toBeTruthy()
})

test('approving posts exactly the gate and run revisions the page showed', async () => {
  post = () =>
    json(
      orchestrationFixtures['/api/orchestrations'] &&
        (orchestrationFixtures['/api/orchestrations'] as { items: unknown[] }).items[0],
    )
  mount(<OrchestrationLive orchestrationId="orch-1" />)
  const gate = await screen.findByRole('region', { name: 'Approve s3' })
  fireEvent.click(within(gate).getByRole('button', { name: 'Approve s3' }))
  await waitFor(() => expect(requests.some((r) => r.url.endsWith('/gates/g3/decision'))).toBe(true))
  const request = requests.find((r) => r.url.endsWith('/gates/g3/decision'))!
  expect(JSON.parse(String(request.init?.body))).toEqual({
    decision: 'approve',
    expectedRevision: 1,
    orchestrationRevision: 9,
  })
  expect(new Headers(request.init?.headers).get('Idempotency-Key')).toBeTruthy()
})

test('a stale decision (409 conflict) is explained and the run is read again', async () => {
  post = () =>
    json({ error: { code: 'conflict', message: 'stale', details: { currentRevision: 10 } } }, 409)
  mount(<OrchestrationLive orchestrationId="orch-1" />)
  const gate = await screen.findByRole('region', { name: 'Approve s3' })
  const before = requests.filter((r) => r.url === '/api/orchestrations/orch-1').length
  fireEvent.click(within(gate).getByRole('button', { name: 'Approve s3' }))
  expect(await within(gate).findByText(/This changed while you were looking/)).toBeTruthy()
  await waitFor(() =>
    expect(requests.filter((r) => r.url === '/api/orchestrations/orch-1').length).toBeGreaterThan(
      before,
    ),
  )
})

test('clicking a node filters the log to it and opens its output', async () => {
  mount(<OrchestrationLive orchestrationId="orch-1" />)
  const log = await screen.findByRole('log', { name: 'Events' })
  expect(within(log).getByText(/Lead turn 1 started/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Step s1, builder/ }))
  expect(within(log).queryByText(/Lead turn 1 started/)).toBeNull()
  expect(within(log).getByText(/s1 succeeded/)).toBeTruthy()
  const selected = screen.getByRole('region', { name: 'Selected node' })
  expect(within(selected).getAllByText(/Draft ready: 14 changes/).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: 'Show everything' }))
  expect(within(log).getByText(/Lead turn 1 started/)).toBeTruthy()
})

test('a dot travels only for an event that arrives after the page loaded, and not for old ones', async () => {
  const { queryClient } = mount(<OrchestrationLive orchestrationId="orch-1" />)
  await screen.findByRole('log', { name: 'Events' })
  // Nothing from the history moves.
  expect(document.querySelectorAll('.orch-dot')).toHaveLength(0)
  const next = structuredClone(orchestrationEvents)
  next.events.push({
    id: 'e17',
    at: '2026-10-08T21:31:30.000Z',
    kind: 'step_result',
    stepId: 's2',
    attemptId: 'a3',
    tool: null,
    verdict: 'succeeded',
    code: null,
    summary: 's2 succeeded (reviewer)',
  })
  events = next
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ['orchestrations', 'run', 'orch-1'] })
  })
  await waitFor(() => expect(document.querySelectorAll('.orch-dot').length).toBe(1))
  expect(within(screen.getByRole('log')).getByText(/s2 succeeded/)).toBeTruthy()
})

test('with reduced motion nothing travels: the nodes and the edge are highlighted instead', async () => {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: true,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  )
  const { queryClient } = mount(<OrchestrationLive orchestrationId="orch-1" />)
  await screen.findByRole('log', { name: 'Events' })
  const next = structuredClone(orchestrationEvents)
  next.events.push({
    id: 'e17',
    at: '2026-10-08T21:31:30.000Z',
    kind: 'step_result',
    stepId: 's1',
    attemptId: 'a2',
    tool: null,
    verdict: 'succeeded',
    code: null,
    summary: 's1 succeeded again',
  })
  events = next
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ['orchestrations', 'run', 'orch-1'] })
  })
  await waitFor(() => expect(document.querySelector('.orch-node--lit')).not.toBeNull())
  expect(document.querySelectorAll('.orch-dot')).toHaveLength(0)
  expect(document.querySelector('.orch-edge--lit')).not.toBeNull()
})

test('a run that is over can be replayed from the recorded events', async () => {
  const done = structuredClone(orchestrationSnapshot)
  done.orchestration.status = 'succeeded'
  done.orchestration.endedAt = '2026-10-08T21:30:00.000Z'
  done.orchestration.needsYou = []
  orchestrationFixtures['/api/orchestrations/orch-1'] = done
  try {
    mount(<OrchestrationLive orchestrationId="orch-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Replay this run' }))
    const scrub = screen.getByRole('slider', { name: 'Replay position' })
    expect((scrub as HTMLInputElement).value).toBe('0')
    expect(screen.queryByRole('button', { name: /Step s1/ })).toBeNull()
    fireEvent.change(scrub, { target: { value: '10' } })
    expect(screen.getByRole('button', { name: /Step s1, builder, succeeded/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Step s2/ })).toBeNull()
    fireEvent.change(scrub, { target: { value: '4' } })
    expect(screen.getByRole('button', { name: /Step s1, builder, queued/ })).toBeTruthy()
    expect(within(screen.getByRole('log')).queryByText(/s1 succeeded/)).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: '16×' }))
    expect(screen.getByRole('radio', { name: '16×' }).getAttribute('aria-checked')).toBe('true')
  } finally {
    orchestrationFixtures['/api/orchestrations/orch-1'] = orchestrationSnapshot
  }
})

test('the start screen shows the acknowledgement, the gate notes, the unknown tool readiness and per-turn estimates', async () => {
  const created = vi.fn()
  post = () =>
    json(
      {
        orchestration: (orchestrationFixtures['/api/orchestrations'] as { items: unknown[] })
          .items[0],
        preflight,
      },
      201,
    )
  mount(<NewOrchestrationDialog agents={agents as never} close={() => {}} created={created} />)
  const dialog = await screen.findByRole('dialog', { name: 'New orchestration' })
  expect(await within(dialog).findByText('Every step waits for you.')).toBeTruthy()
  expect(within(dialog).getByText(/Can't be checked/)).toBeTruthy()
  expect(within(dialog).getByText(/per lead turn and per step/)).toBeTruthy()
  const start = within(dialog).getByRole('button', { name: 'Start orchestration' })
  expect((start as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(within(dialog).getByLabelText('Goal'), { target: { value: 'Ship it' } })
  fireEvent.click(within(dialog).getByLabelText('builder'))
  fireEvent.click(within(dialog).getByLabelText(/Score controls the work it starts/))
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(start)
  await waitFor(() => expect(created).toHaveBeenCalled())
  const request = requests.find(
    (r) => r.url === '/api/orchestrations' && r.init?.method === 'POST',
  )!
  const body = JSON.parse(String(request.init?.body)) as Record<string, unknown>
  expect(body).toMatchObject({
    goal: 'Ship it',
    leadAgentId: 'lead',
    allowedAgents: ['builder'],
    gatePolicy: 'every-step',
    leadTurnEstimateUsd: 0.25,
    stepEstimateUsd: 0.5,
  })
  expect((body.acknowledgement as { text: string }).text).toMatch(/^Score controls the work/)
})

test('a replaced agent asks for a remap decision paired with the incarnations the page showed', async () => {
  const snapshot = orchestrationFixtures['/api/orchestrations/orch-1'] as {
    orchestration: { needsYou: unknown[] }
  }
  const original = snapshot.orchestration.needsYou
  snapshot.orchestration.needsYou = [
    ...original,
    {
      kind: 'remap',
      agentId: 'builder',
      role: 'agent',
      frozenIncarnation: 'inc-a',
      currentIncarnation: 'inc-b',
    },
  ]
  post = () => json((orchestrationFixtures['/api/orchestrations'] as { items: unknown[] }).items[0])
  try {
    mount(<OrchestrationLive orchestrationId="orch-1" />)
    const card = await screen.findByRole('region', { name: 'Replaced builder' })
    fireEvent.click(within(card).getByRole('button', { name: 'Use the new builder for this run' }))
    await waitFor(() => expect(requests.some((r) => r.url.endsWith('/orch-1/remap'))).toBe(true))
    const request = requests.find((r) => r.url.endsWith('/orch-1/remap'))!
    expect(JSON.parse(String(request.init?.body))).toEqual({
      agentId: 'builder',
      frozenIncarnation: 'inc-a',
      currentIncarnation: 'inc-b',
      orchestrationRevision: 9,
      acknowledge: true,
    })
  } finally {
    snapshot.orchestration.needsYou = original
  }
})
