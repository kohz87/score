import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  okValidation,
  runEvents,
  runSnapshot,
  runSummary,
  unfinishedValidation,
  workflowFixtures,
  workflowPreflight,
} from '../../../../../e2e/workflow-fixtures.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { StartWorkflowDialog } from './StartWorkflowDialog.tsx'
import { WorkflowRunLive } from './WorkflowRunLive.tsx'

class Source extends EventTarget {
  close() {}
}
const agents = [
  {
    id: 'lead',
    name: 'lead',
    style: { color: '#6B4EFF', shape: 'circle-dot' },
    status: 'idle',
    role: '',
  },
  {
    id: 'builder',
    name: 'builder',
    style: { color: '#19C39A', shape: 'square' },
    status: 'idle',
    role: '',
  },
  {
    id: 'reviewer',
    name: 'reviewer',
    style: { color: '#FFB61E', shape: 'triangle' },
    status: 'idle',
    role: '',
  },
]
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

let requests: { url: string; init?: RequestInit }[]
let snapshot: unknown
let post: (url: string, init?: RequestInit) => Response | undefined
const dispose: (() => void)[] = []

beforeEach(() => {
  requests = []
  snapshot = runSnapshot
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
      const method = init?.method ?? 'GET'
      if (method === 'POST') {
        const custom = post(url, init)
        if (custom) return Promise.resolve(custom)
        if (url === '/api/workflows/validate') {
          const body = JSON.parse(String(init?.body)) as { definition: { name: string } }
          return Promise.resolve(
            json(body.definition.name.includes('(draft)') ? unfinishedValidation : okValidation),
          )
        }
      }
      if (url === '/api/agents') return Promise.resolve(json({ asOfSeq: 1, items: agents }))
      if (url === '/api/workflow-runs/wfrun-1') return Promise.resolve(json(snapshot))
      if (url.startsWith('/api/workflow-runs/preflight'))
        return Promise.resolve(json(workflowPreflight))
      const fixture = workflowFixtures[url]
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

function providers(children: React.ReactNode) {
  const queryClient = createQueryClient()
  const client = createStreamClient({ EventSourceImpl: Source })
  const queries = createStreamQueryRegistry(queryClient, client)
  dispose.push(() => {
    queries.dispose()
    client.close()
    queryClient.clear()
  })
  return (
    <QueryClientProvider client={queryClient}>
      <StreamContext value={{ client, queries }}>{children}</StreamContext>
    </QueryClientProvider>
  )
}
function mount(ui: React.ReactElement) {
  render(providers(<MemoryRouter>{ui}</MemoryRouter>))
}
const revisionOf = (patch: (run: Record<string, unknown>) => void) => {
  const copy = structuredClone(runSnapshot) as unknown as { run: Record<string, unknown> }
  patch(copy.run)
  return copy
}
const started = () => {}

test('the run view draws the graph from the definition: shapes, states, the gate that waits, and the log', async () => {
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  await screen.findByRole('log', { name: 'Events' })
  expect(
    screen.getByRole('button', { name: /^Step Draft the notes, builder, succeeded/ }),
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: /^Gate Approve the draft, needs you$/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /^Branch Passed review\?, waiting$/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: /^End Published, waiting$/ })).toBeTruthy()
  // The status is the executor's; no graph outcome yet.
  expect(screen.getByText('Running', { exact: true })).toBeTruthy()
  expect(screen.queryByText(/Workflow reached its end/)).toBeNull()
  // Edges carry words where they need them; the log says what the planner did.
  expect([...document.querySelectorAll('.orch-edge-label')].map((e) => e.textContent)).toEqual(
    expect.arrayContaining(['approved', 'verdict passed', 'otherwise']),
  )
  expect(
    within(screen.getByRole('log')).getByText('Draft the notes started (builder)'),
  ).toBeTruthy()
  expect(screen.getByText(/spend settled/)).toBeTruthy()
})

test('the node gate shows what it was shown when it opened, and approving posts both revisions', async () => {
  post = () => json(runSummary)
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  const gate = await screen.findByRole('region', { name: 'Decide on Approve the draft' })
  expect(within(gate).getByText('Is the reviewed draft good enough to publish?')).toBeTruthy()
  expect(within(gate).getByText(/result version 1/)).toBeTruthy()
  expect(within(gate).getByText(/Rejecting stops the run/)).toBeTruthy()
  fireEvent.click(within(gate).getByRole('button', { name: 'Approve' }))
  await waitFor(() =>
    expect(requests.some((r) => r.url.endsWith('/gates/wg-1/decision'))).toBe(true),
  )
  const request = requests.find((r) => r.url.endsWith('/gates/wg-1/decision'))!
  expect(request.url).toBe('/api/workflow-runs/wfrun-1/gates/wg-1/decision')
  expect(JSON.parse(String(request.init?.body))).toEqual({
    decision: 'approve',
    expectedRevision: 1,
    orchestrationRevision: 14,
  })
  expect(new Headers(request.init?.headers).get('Idempotency-Key')).toBeTruthy()
})

test('a stale decision (409 conflict) is explained in words and the run is read again', async () => {
  post = () =>
    json({ error: { code: 'conflict', message: 'stale', details: { currentRevision: 15 } } }, 409)
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  const gate = await screen.findByRole('region', { name: 'Decide on Approve the draft' })
  const before = requests.filter((r) => r.url === '/api/workflow-runs/wfrun-1').length
  fireEvent.click(within(gate).getByRole('button', { name: 'Reject' }))
  expect(await within(gate).findByText(/This changed while you were looking/)).toBeTruthy()
  await waitFor(() =>
    expect(requests.filter((r) => r.url === '/api/workflow-runs/wfrun-1').length).toBeGreaterThan(
      before,
    ),
  )
})

test('an abandoned node offers Retry with the node revision and the acknowledgement, and Stop', async () => {
  snapshot = revisionOf((run) => {
    run.needsYou = [{ kind: 'retry', nodeId: 'repair', attemptsLeft: 1 }]
    ;(run.nodeStates as { nodeId: string }[]).forEach((n) => {
      if (n.nodeId === 'repair')
        Object.assign(n, {
          state: 'unresolved',
          revision: 7,
          attemptsMax: 2,
          attemptsUsed: 1,
          canRetry: true,
        })
    })
  })
  post = () => json(runSummary)
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  const card = await screen.findByRole('region', { name: 'Retry Repair the draft' })
  const retry = within(card).getByRole('button', { name: 'Retry Repair the draft' })
  expect((retry as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(card).getByRole('checkbox'))
  fireEvent.click(retry)
  await waitFor(() =>
    expect(requests.some((r) => r.url.endsWith('/nodes/repair/retry'))).toBe(true),
  )
  expect(
    JSON.parse(String(requests.find((r) => r.url.endsWith('/nodes/repair/retry'))!.init?.body)),
  ).toEqual({
    expectedNodeRevision: 7,
    orchestrationRevision: 14,
    acknowledge: true,
  })
  fireEvent.click(within(card).getByRole('button', { name: 'Stop the run' }))
  await waitFor(() => expect(requests.some((r) => r.url.endsWith('/stop'))).toBe(true))
})

test('after twenty refusals the person chooses Try again or Stop, bound to the node revision', async () => {
  snapshot = revisionOf((run) => {
    run.needsYou = [{ kind: 'refusal_limit', nodeId: 'repair', attemptId: 'wa9', refusals: 20 }]
    ;(run.nodeStates as { nodeId: string }[]).forEach((n) => {
      if (n.nodeId === 'repair')
        Object.assign(n, { state: 'ready', revision: 4, waitingFor: 'refusal_limit' })
    })
  })
  post = () => json(runSummary)
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  const card = await screen.findByRole('region', { name: 'Hermes refused Repair the draft' })
  expect(within(card).getByText(/refused this step 20 times/)).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: 'Try again' }))
  await waitFor(() =>
    expect(requests.some((r) => r.url.endsWith('/nodes/repair/try-again'))).toBe(true),
  )
  expect(
    JSON.parse(String(requests.find((r) => r.url.endsWith('/try-again'))!.init?.body)),
  ).toEqual({
    expectedNodeRevision: 4,
    orchestrationRevision: 14,
  })
})

test('a replaced agent shows the exact plan, and the decision carries the plan it showed; a changed plan is explained', async () => {
  snapshot = revisionOf((run) => {
    run.needsYou = [
      {
        kind: 'remap',
        agentId: 'reviewer',
        frozenIncarnation: 'old-incarnation',
        currentIncarnation: 'new-incarnation',
        nodeIds: ['repair'],
        plan: [
          {
            nodeId: 'repair',
            retiresAttemptId: null,
            payloadHash: 'hash-1',
            payload: 'Fix what the review found.',
          },
        ],
      },
    ]
  })
  post = () => json({ error: { code: 'stale_plan', message: 'changed' } }, 409)
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  const card = await screen.findByRole('region', { name: 'Replaced reviewer' })
  expect(within(card).getByText('old-incarnation')).toBeTruthy()
  expect(within(card).getByText('new-incarnation')).toBeTruthy()
  fireEvent.click(card.querySelector('summary')!)
  expect(within(card).getByText('Fix what the review found.')).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: 'Use the new reviewer for this run' }))
  await waitFor(() => expect(requests.some((r) => r.url.endsWith('/remap'))).toBe(true))
  expect(JSON.parse(String(requests.find((r) => r.url.endsWith('/remap'))!.init?.body))).toEqual({
    agentId: 'reviewer',
    frozenIncarnation: 'old-incarnation',
    currentIncarnation: 'new-incarnation',
    orchestrationRevision: 14,
    acknowledge: true,
    plan: [{ nodeId: 'repair', payloadHash: 'hash-1' }],
  })
  expect(await within(card).findByText(/What would be re-created changed/)).toBeTruthy()
})

test('a finished run says both what the executor did and what the graph did', async () => {
  snapshot = revisionOf((run) => {
    Object.assign(run, {
      status: 'finished_with_unresolved',
      graphOutcome: 'reached_end',
      outcomeNote: 'Workflow reached its end — 1 step run not confirmed as ended',
      needsYou: [],
      endedAt: '2026-10-10T10:00:00.000Z',
    })
  })
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  await screen.findByRole('log', { name: 'Events' })
  expect(screen.getByText('Finished, not everything confirmed')).toBeTruthy()
  expect(screen.getAllByText('Workflow reached its end').length).toBeGreaterThan(0)
  expect(
    screen.getByText('Workflow reached its end — 1 step run not confirmed as ended'),
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Replay this run' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Run again…' })).toBeTruthy()
})

test('clicking a node filters the log to it and shows what it read, its verdict and its output', async () => {
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  const log = await screen.findByRole('log', { name: 'Events' })
  fireEvent.click(screen.getByRole('button', { name: /^Step Review the draft/ }))
  const panel = screen.getByRole('region', { name: 'Selected step' })
  expect(within(panel).getByText(/The output of Draft the notes/)).toBeTruthy()
  expect(within(panel).getByText(/result version 1/, { selector: 'li' })).toBeTruthy()
  expect(within(panel).getByText(/Verdict: passed/)).toBeTruthy()
  expect(within(log).queryByText('Draft the notes started (builder)')).toBeNull()
  expect(within(log).getByText('Review the draft started (reviewer)')).toBeTruthy()
  expect(within(panel).getByText(/shows all the agent’s work/)).toBeTruthy()
})

test('a dot travels for a token event that arrives after the page loaded, not for old ones', async () => {
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
        <MemoryRouter>
          <WorkflowRunLive runId="wfrun-1" onStarted={started} />
        </MemoryRouter>
      </StreamContext>
    </QueryClientProvider>,
  )
  await screen.findByRole('log', { name: 'Events' })
  expect(document.querySelectorAll('.orch-dot')).toHaveLength(0)
  const key = ['workflow-runs', 'run', 'wfrun-1']
  const current = queryClient.getQueryData<{ snapshot: unknown; events: unknown[] }>(key)!
  const more = {
    ...current,
    events: [
      ...current.events,
      {
        ...(runEvents.events[4] as object),
        id: 'h99',
        kind: 'token',
        edgeId: 'e3',
        nodeId: 'approve',
        summary: 'token ok on e3',
      },
    ],
  }
  await act(async () => {
    queryClient.setQueryData(key, more)
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  await waitFor(() => expect(document.querySelectorAll('.orch-dot').length).toBe(1))
})

test('the start dialog needs the inputs, shows the exact incarnations and posts them with the acknowledgement', async () => {
  post = (url) =>
    url === '/api/workflow-runs'
      ? json({ run: runSummary, preflight: workflowPreflight }, 201)
      : undefined
  const created = vi.fn()
  mount(
    <StartWorkflowDialog
      workflowId="wf-release"
      agents={agents as never}
      close={() => {}}
      created={created}
    />,
  )
  const dialog = await screen.findByRole('dialog', { name: /Start Release notes/ })
  await within(dialog).findByRole('list', { name: 'Agent mapping' })
  expect(within(dialog).getByText('4f7c1d2e-8a3b-4c5d-9e6f-0a1b2c3d4e5f')).toBeTruthy()
  expect(within(dialog).getByText(/Only the gates you drew stop for you/)).toBeTruthy()
  const submit = within(dialog).getByRole('button', { name: 'Start the run' }) as HTMLButtonElement
  expect(submit.disabled).toBe(true)
  fireEvent.click(
    within(dialog).getByRole('checkbox', { name: /Score controls the work it starts/ }),
  )
  expect(submit.disabled).toBe(true) // the required input is still empty
  fireEvent.change(within(dialog).getByLabelText(/^Topic/), {
    target: { value: 'the 2.4 release' },
  })
  await waitFor(() => expect(submit.disabled).toBe(false))
  fireEvent.click(within(dialog).getByRole('radio', { name: /every agent step/ }))
  fireEvent.click(within(dialog).getByRole('radio', { name: /Keep going/ }))
  fireEvent.click(submit)
  await waitFor(() => expect(created).toHaveBeenCalled())
  const body = JSON.parse(
    String(
      requests.find((r) => r.url === '/api/workflow-runs' && r.init?.method === 'POST')!.init?.body,
    ),
  )
  expect(body).toMatchObject({
    workflowId: 'wf-release',
    version: 1,
    inputs: { topic: 'the 2.4 release' },
    gatePolicy: 'every-step',
    unknownSpend: 'continue',
    agentMap: [
      { agentId: 'builder', incarnation: '4f7c1d2e-8a3b-4c5d-9e6f-0a1b2c3d4e5f' },
      { agentId: 'reviewer', incarnation: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' },
    ],
  })
  expect(body.acknowledgement.text).toMatch(/Score controls the work it starts/)
})

test('the run view draws the nodes where the saved version put them, and the edges follow', async () => {
  snapshot = revisionOf((run) => {
    ;(run.definition as { layout?: unknown }).layout = {
      nodes: { draft: { x: 48, y: 400 }, review: { x: 480, y: 16 } },
    }
  })
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  await screen.findByRole('log', { name: 'Events' })
  const box = (name: RegExp) =>
    screen.getByRole('button', { name }).closest<HTMLElement>('[style*="left"]')!
  expect(box(/^Step Draft the notes/).style.left).toBe('48px')
  expect(box(/^Step Draft the notes/).style.top).toBe('400px')
  expect(box(/^Step Review the draft/).style.left).toBe('480px')
  // The edge between them starts at the right side of the first and ends at the left side of the second.
  const d = document.querySelector('[data-edge="e1"]')!.getAttribute('d')!
  const first = d.split(' L ')[0]!.replace('M ', '').split(' ').map(Number)
  const last = d.split(' L ').at(-1)!.split(' ').map(Number)
  expect(first[0]).toBeGreaterThan(48)
  expect(last[0]).toBe(480)
})
