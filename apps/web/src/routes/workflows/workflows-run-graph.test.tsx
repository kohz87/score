import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, test, vi } from 'vitest'
import { runEvents } from '../../../../../e2e/workflow-fixtures.ts'
import { createQueryClient, StreamContext } from '../../data/query-client.ts'
import { createStreamQueryRegistry } from '../../data/resync.ts'
import { createStreamClient } from '../../data/stream.ts'
import { WorkflowRunLive } from './WorkflowRunLive.tsx'
import { revisionOf, setUpWorkflowTests, Source, started } from './workflows-test-helpers.tsx'

const { state, mount, dispose } = setUpWorkflowTests()

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

test('the run view draws the nodes where the saved version put them, and the edges follow', async () => {
  state.snapshot = revisionOf((run) => {
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
