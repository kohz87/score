import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  codingPolicyB,
  codingPreflight,
  codingRunSnapshot,
  codingTeam,
  runEvents,
} from '../../../../../e2e/workflow-fixtures.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { WorkflowRunLive } from './WorkflowRunLive.tsx'

// 7.7c-2: a workflow run with coding steps in the browser: the CLI badge, the four coding cards of the Needs-you list and
// the shared limits card, each posting to the workflow's own endpoints. No lead is involved anywhere.

class Source extends EventTarget {
  close() {}
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })

let requests: { url: string; init?: RequestInit }[]
let snapshot: unknown
let preflight: unknown
const dispose: (() => void)[] = []

beforeEach(() => {
  requests = []
  preflight = codingPreflight
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
      if ((init?.method ?? 'GET') === 'POST')
        return Promise.resolve(json({ error: { code: 'x', message: 'stop' } }, 500))
      if (url === '/api/agents')
        return Promise.resolve(
          json({
            asOfSeq: 1,
            items: codingTeam.map((agent) => ({
              activity: null,
              model: null,
              served: true,
              ...agent,
            })),
          }),
        )
      if (url === '/api/workflow-runs/wfrun-1') return Promise.resolve(json(snapshot))
      if (url === '/api/workflow-runs/wfrun-1/events') return Promise.resolve(json(runEvents))
      if (url.startsWith('/api/workflow-runs/preflight')) return Promise.resolve(json(preflight))
      return Promise.resolve(json({ error: { code: 'not_found', message: 'none' } }, 404))
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
}
const live = () => mount(<WorkflowRunLive runId="wfrun-1" onStarted={() => {}} />)
const posted = (suffix: string) =>
  requests.find((r) => r.init?.method === 'POST' && r.url.endsWith(suffix))
const body = (suffix: string) => JSON.parse(String(posted(suffix)!.init!.body)) as unknown

test('a coding step shows the program it runs on, next to the agent', async () => {
  snapshot = codingRunSnapshot([], { waitingFor: null })
  live()
  expect(
    await screen.findByRole('button', { name: /^Step Draft the notes, coder-a \(Codex\)/ }),
  ).toBeTruthy()
  expect(
    screen.getByRole('button', { name: /^Step Review the draft, coder-b \(Claude Code\)/ }),
  ).toBeTruthy()
})

test('new settings: the card asks the workflow’s own check, needs the reach accepted, and posts the node’s policy remap', async () => {
  snapshot = codingRunSnapshot(
    [
      {
        kind: 'coding_agent_changed',
        nodeId: 'draft',
        agentId: 'coder-a',
        newPolicyId: null,
        reach: null,
      },
    ],
    { waitingFor: 'coding_settings' },
  )
  live()
  const card = await screen.findByRole('region', { name: 'New settings for coder-a' })
  expect(within(card).getByText(/Draft the notes is blocked because coder-a/)).toBeTruthy()
  await within(card).findByText(/With the new settings: Reads any file you can read/)
  // The workflow's preflight answered it. No orchestration, no lead.
  expect(
    requests.some((r) =>
      r.url.startsWith('/api/workflow-runs/preflight?workflowId=wf-release&version=1'),
    ),
  ).toBe(true)
  expect(requests.some((r) => r.url.includes('orchestrations/preflight'))).toBe(false)
  const button = within(card).getByRole('button', {
    name: 'Use the new settings',
  }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(within(card).getByRole('checkbox', { name: /I understand what it can read now/ }))
  await waitFor(() => expect(button.disabled).toBe(false))
  fireEvent.click(button)
  await waitFor(() => expect(posted('/nodes/draft/policy-remap')).toBeTruthy())
  expect(posted('/nodes/draft/policy-remap')!.url).toBe(
    '/api/workflow-runs/wfrun-1/nodes/draft/policy-remap',
  )
  expect(body('/nodes/draft/policy-remap')).toEqual({
    policyId: codingPolicyB,
    acknowledgeCodingReach: { policyIds: [codingPolicyB] },
    expectedNodeRevision: 4,
    orchestrationRevision: 14,
  })
})

test('limit reached: the run’s coding limit is raised through the workflow’s limits decision', async () => {
  snapshot = codingRunSnapshot([{ kind: 'coding_limit', used: 4, limit: 4 }], {
    waitingFor: 'coding_limit',
  })
  live()
  const card = await screen.findByRole('region', { name: 'Coding step limit' })
  expect(within(card).getByText('The run reached its limit of coding steps')).toBeTruthy()
  expect(within(card).getByText(/up to 4 coding steps/)).toBeTruthy()
  fireEvent.change(within(card).getByLabelText(/New limit/), { target: { value: '9' } })
  fireEvent.click(within(card).getByRole('button', { name: 'Raise the limit and continue' }))
  await waitFor(() => expect(posted('/workflow-runs/wfrun-1/limits')).toBeTruthy())
  expect(body('/limits')).toEqual({ orchestrationRevision: 14, codingSteps: 9 })
})

test('held back 20 times: Try again renews the step, and says how many chances are left', async () => {
  snapshot = codingRunSnapshot([{ kind: 'coding_held_back', nodeId: 'draft' }], {
    waitingFor: 'held_back',
    renewals: 2,
  })
  live()
  const card = await screen.findByRole('region', { name: 'Draft the notes was held back' })
  expect(within(card).getByText(/1 chance left for this step/)).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(posted('/nodes/draft/try-again')).toBeTruthy())
  expect(body('/nodes/draft/try-again')).toEqual({
    expectedNodeRevision: 4,
    orchestrationRevision: 14,
  })
  fireEvent.click(within(card).getByRole('button', { name: 'Stop the run' }))
  await waitFor(() => expect(posted('/workflow-runs/wfrun-1/stop')).toBeTruthy())
})

test('lost input: the card says nothing ran, and Retry posts the step’s retry', async () => {
  snapshot = codingRunSnapshot([{ kind: 'node_inputs_withdrawn', nodeId: 'draft' }], {
    state: 'unresolved',
    canRetry: true,
  })
  live()
  const card = await screen.findByRole('region', { name: 'Draft the notes lost its input' })
  expect(within(card).getByText(/nothing ran and the try wasn’t used/)).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: 'Retry Draft the notes' }))
  await waitFor(() => expect(posted('/nodes/draft/retry')).toBeTruthy())
  expect(body('/nodes/draft/retry')).toEqual({
    expectedNodeRevision: 4,
    orchestrationRevision: 14,
    acknowledge: true,
  })
})

test('unknown cost is accepted per source from the run’s coding block, without a lead', async () => {
  snapshot = codingRunSnapshot(
    [{ kind: 'budget', reason: 'unknown_spend' }],
    {},
    {
      acceptedUnknownCost: ['claude-code'],
    },
  )
  live()
  const card = await screen.findByRole('region', { name: 'Budget or deadline' })
  expect(within(card).queryByRole('button', { name: /Claude Code cost is unknown/ })).toBeNull()
  fireEvent.click(
    within(card).getByRole('button', { name: 'Continue although Codex cost is unknown' }),
  )
  await waitFor(() => expect(posted('/workflow-runs/wfrun-1/limits')).toBeTruthy())
  expect(body('/limits')).toEqual({
    orchestrationRevision: 14,
    acceptUnknownCost: { add: ['codex'] },
  })
})

test('the budget block shows the coding steps used and the sources whose unknown cost is accepted', async () => {
  snapshot = codingRunSnapshot([], {}, { used: 2, acceptedUnknownCost: ['codex'] })
  live()
  const budget = await screen.findByRole('region', { name: 'Budget and limits' })
  expect(within(budget).getByText(/2 of 4 used; you accepted unknown cost for Codex/)).toBeTruthy()
})
