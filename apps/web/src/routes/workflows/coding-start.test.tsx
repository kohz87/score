import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  codingPolicyA,
  codingPolicyB,
  codingPreflight,
  codingTeam,
  workflowFixtures,
  workflowPreflight,
} from '../../../../../e2e/workflow-fixtures.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { StartWorkflowDialog } from './StartWorkflowDialog.tsx'

// 7.7c-2 #4: the run dialog of a workflow with coding steps: what each coding agent can read and the risk in the 7.7b
// words, one acknowledgement by policy id, unknown cost per program, the coding step limit; a rerun asks again.

class Source extends EventTarget {
  close() {}
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
let requests: { url: string; init?: RequestInit }[]
let preflight: Record<string, unknown>
let post: (url: string) => Response | undefined
const dispose: (() => void)[] = []

beforeEach(() => {
  requests = []
  preflight = codingPreflight as unknown as Record<string, unknown>
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
      if ((init?.method ?? 'GET') === 'POST')
        return Promise.resolve(
          post(url) ?? json({ error: { code: 'x', message: 'stop here' } }, 500),
        )
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
      if (url.startsWith('/api/workflow-runs/preflight')) return Promise.resolve(json(preflight))
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

function open(props: { rerunOf?: string } = {}) {
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
          <StartWorkflowDialog
            workflowId="wf-release"
            agents={codingTeam as never}
            initialInputs={{ topic: 'the 2.4 release' }}
            close={() => {}}
            created={vi.fn()}
            {...props}
          />
        </MemoryRouter>
      </StreamContext>
    </QueryClientProvider>,
  )
}
const startButton = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: 'Start the run' }) as HTMLButtonElement
const createBody = () =>
  JSON.parse(
    String(
      requests.find((r) => r.url === '/api/workflow-runs' && r.init?.method === 'POST')!.init!.body,
    ),
  ) as Record<string, unknown>
const reachBox = (dialog: HTMLElement) =>
  within(dialog).getByRole('checkbox', { name: /I understand what these coding agents can read/ })

test('the dialog says what each coding agent can read, asks for one acknowledgement, and sends policies, limit and unknown cost', async () => {
  open()
  const dialog = await screen.findByRole('dialog', { name: /Start Release notes/ })
  const section = await within(dialog).findByRole('region', { name: 'Coding agents in this run' })
  expect(
    within(section).getByText(/Reads any file you can read, not only the ones in \/work\/site/),
  ).toBeTruthy()
  // The 7.7b warning, with the destination of a workflow's answer (later steps, not a lead).
  expect(
    within(section).getByText(/Whatever a coding agent can read, it can repeat in its answer/),
  ).toBeTruthy()
  expect(
    within(section).getByText(/passed to the steps after it, which may use an online model/),
  ).toBeTruthy()
  expect(within(section).queryByText(/the lead/)).toBeNull()
  fireEvent.click(within(dialog).getByLabelText(/Score controls the work it starts/))
  await waitFor(() => expect(startButton(dialog).disabled).toBe(true))
  fireEvent.click(reachBox(dialog))
  await waitFor(() => expect(startButton(dialog).disabled).toBe(false))
  // The limit defaults to the number of coding tries; the person can change it.
  fireEvent.click(within(dialog).getByText('Limits and estimates'))
  expect((within(dialog).getByLabelText('Most coding steps') as HTMLInputElement).value).toBe('4')
  fireEvent.change(within(dialog).getByLabelText('Most coding steps'), { target: { value: '6' } })
  // With "pause", unknown cost is accepted per program.
  fireEvent.click(within(dialog).getByLabelText(/Keep going when the cost of Codex is unknown/))
  expect(
    within(dialog).getByLabelText(/Keep going when the cost of Claude Code is unknown/),
  ).toBeTruthy()
  fireEvent.click(startButton(dialog))
  await waitFor(() => expect(requests.some((r) => r.init?.method === 'POST')).toBe(true))
  expect(createBody()).toMatchObject({
    workflowId: 'wf-release',
    unknownSpend: 'pause',
    codingPolicies: { 'coder-a': codingPolicyB, 'coder-b': codingPolicyB },
    acknowledgeCodingReach: { policyIds: [codingPolicyB] },
    codingSteps: 6,
    acceptUnknownCost: ['codex'],
  })
})

test('"keep going" accepts every program, so no per-program choice is shown or sent', async () => {
  open()
  const dialog = await screen.findByRole('dialog', { name: /Start Release notes/ })
  await within(dialog).findByRole('region', { name: 'Coding agents in this run' })
  expect(within(dialog).getByLabelText(/Keep going when the cost of Codex is unknown/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('radio', { name: /Keep going/ }))
  expect(within(dialog).queryByLabelText(/Keep going when the cost of Codex is unknown/)).toBeNull()
  fireEvent.click(within(dialog).getByLabelText(/Score controls the work it starts/))
  fireEvent.click(reachBox(dialog))
  await waitFor(() => expect(startButton(dialog).disabled).toBe(false))
  fireEvent.click(startButton(dialog))
  await waitFor(() => expect(requests.some((r) => r.init?.method === 'POST')).toBe(true))
  const body = createBody()
  expect(body['unknownSpend']).toBe('continue')
  expect(body['acceptUnknownCost']).toBeUndefined()
})

test('a workflow with Hermes agents only shows and sends no coding fields', async () => {
  preflight = workflowPreflight as unknown as Record<string, unknown>
  open()
  const dialog = await screen.findByRole('dialog', { name: /Start Release notes/ })
  await within(dialog).findByRole('list', { name: 'Agent mapping' })
  expect(within(dialog).queryByRole('region', { name: 'Coding agents in this run' })).toBeNull()
  fireEvent.click(within(dialog).getByText('Limits and estimates'))
  expect(within(dialog).queryByLabelText('Most coding steps')).toBeNull()
  fireEvent.click(within(dialog).getByLabelText(/Score controls the work it starts/))
  await waitFor(() => expect(startButton(dialog).disabled).toBe(false))
  fireEvent.click(startButton(dialog))
  await waitFor(() => expect(requests.some((r) => r.init?.method === 'POST')).toBe(true))
  const body = createBody()
  for (const field of [
    'codingPolicies',
    'codingSteps',
    'acknowledgeCodingReach',
    'acceptUnknownCost',
  ])
    expect(Object.hasOwn(body, field)).toBe(false)
})

test('a rerun asks again, and an acknowledgement never carries over to a changed policy id', async () => {
  post = () =>
    json(
      { error: { code: 'policy_changed', message: 'changed', details: { agentId: 'coder-a' } } },
      409,
    )
  open({ rerunOf: 'wfrun-1' })
  const dialog = await screen.findByRole('dialog', { name: /Run again Release notes/ })
  await within(dialog).findByRole('region', { name: 'Coding agents in this run' })
  // Nothing is accepted yet, however the earlier run was started.
  expect((reachBox(dialog) as HTMLInputElement).checked).toBe(false)
  fireEvent.click(within(dialog).getByLabelText(/Score controls the work it starts/))
  fireEvent.click(reachBox(dialog))
  await waitFor(() => expect(startButton(dialog).disabled).toBe(false))
  // coder-a changed while the dialog was open: the next check names another policy.
  preflight = {
    ...(codingPreflight as unknown as Record<string, unknown>),
    workers: codingPreflight.workers.map((w) =>
      w.agentId === 'coder-a' ? { ...w, policyId: codingPolicyA } : w,
    ),
  }
  fireEvent.click(startButton(dialog))
  await within(dialog).findByText(/A coding agent changed since you looked/)
  await waitFor(() => expect((reachBox(dialog) as HTMLInputElement).checked).toBe(false))
  expect(startButton(dialog).disabled).toBe(true)
  expect(createBody()).toMatchObject({
    rerunOf: 'wfrun-1',
    acknowledgeCodingReach: { policyIds: [codingPolicyB] },
  })
})

test('a coding agent that isn’t ready says why, and the runtime problems of the definition are listed', async () => {
  preflight = {
    ...(codingPreflight as unknown as Record<string, unknown>),
    ok: false,
    issues: [
      {
        code: 'coding_workers_need_units',
        severity: 'error',
        nodeId: 'draft',
        edgeId: null,
        field: 'agentId',
        message:
          'Coding agents can take workflow steps only where Score runs them as supervised system services.',
      },
    ],
    workers: codingPreflight.workers.map((w) =>
      w.agentId === 'coder-a'
        ? { ...w, readiness: 'version_untested', detail: null, policyId: null, reach: null }
        : w,
    ),
  }
  open()
  const dialog = await screen.findByRole('dialog', { name: /Start Release notes/ })
  const section = await within(dialog).findByRole('region', { name: 'Coding agents in this run' })
  expect(within(section).getByText(/hasn’t tested this version/)).toBeTruthy()
  const problems = within(dialog).getByRole('list', { name: 'Problems with the workflow' })
  expect(
    within(problems).getByText(/only where Score runs them as supervised system services/),
  ).toBeTruthy()
  fireEvent.click(within(dialog).getByLabelText(/Score controls the work it starts/))
  expect(startButton(dialog).disabled).toBe(true)
})
