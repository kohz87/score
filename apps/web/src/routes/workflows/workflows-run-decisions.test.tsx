import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { runSummary } from '../../../../../e2e/workflow-fixtures.ts'
import { WorkflowRunLive } from './WorkflowRunLive.tsx'
import { json, revisionOf, setUpWorkflowTests, started } from './workflows-test-helpers.tsx'

const { state, mount } = setUpWorkflowTests()

test('the node gate shows what it was shown when it opened, and approving posts both revisions', async () => {
  state.post = () => json(runSummary)
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  const gate = await screen.findByRole('region', { name: 'Decide on Approve the draft' })
  expect(within(gate).getByText('Is the reviewed draft good enough to publish?')).toBeTruthy()
  expect(within(gate).getByText(/result version 1/)).toBeTruthy()
  expect(within(gate).getByText(/Rejecting stops the run/)).toBeTruthy()
  fireEvent.click(within(gate).getByRole('button', { name: 'Approve' }))
  await waitFor(() =>
    expect(state.requests.some((r) => r.url.endsWith('/gates/wg-1/decision'))).toBe(true),
  )
  const request = state.requests.find((r) => r.url.endsWith('/gates/wg-1/decision'))!
  expect(request.url).toBe('/api/workflow-runs/wfrun-1/gates/wg-1/decision')
  expect(JSON.parse(String(request.init?.body))).toEqual({
    decision: 'approve',
    expectedRevision: 1,
    orchestrationRevision: 14,
  })
  expect(new Headers(request.init?.headers).get('Idempotency-Key')).toBeTruthy()
})

test('a stale decision (409 conflict) is explained in words and the run is read again', async () => {
  state.post = () =>
    json({ error: { code: 'conflict', message: 'stale', details: { currentRevision: 15 } } }, 409)
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  const gate = await screen.findByRole('region', { name: 'Decide on Approve the draft' })
  const before = state.requests.filter((r) => r.url === '/api/workflow-runs/wfrun-1').length
  fireEvent.click(within(gate).getByRole('button', { name: 'Reject' }))
  expect(await within(gate).findByText(/This changed while you were looking/)).toBeTruthy()
  await waitFor(() =>
    expect(
      state.requests.filter((r) => r.url === '/api/workflow-runs/wfrun-1').length,
    ).toBeGreaterThan(before),
  )
})

test('an abandoned node offers Retry with the node revision and the acknowledgement, and Stop', async () => {
  state.snapshot = revisionOf((run) => {
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
  state.post = () => json(runSummary)
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  const card = await screen.findByRole('region', { name: 'Retry Repair the draft' })
  const retry = within(card).getByRole('button', { name: 'Retry Repair the draft' })
  expect((retry as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(card).getByRole('checkbox'))
  fireEvent.click(retry)
  await waitFor(() =>
    expect(state.requests.some((r) => r.url.endsWith('/nodes/repair/retry'))).toBe(true),
  )
  expect(
    JSON.parse(
      String(state.requests.find((r) => r.url.endsWith('/nodes/repair/retry'))!.init?.body),
    ),
  ).toEqual({
    expectedNodeRevision: 7,
    orchestrationRevision: 14,
    acknowledge: true,
  })
  fireEvent.click(within(card).getByRole('button', { name: 'Stop the run' }))
  await waitFor(() => expect(state.requests.some((r) => r.url.endsWith('/stop'))).toBe(true))
})

test('after twenty refusals the person chooses Try again or Stop, bound to the node revision', async () => {
  state.snapshot = revisionOf((run) => {
    run.needsYou = [{ kind: 'refusal_limit', nodeId: 'repair', attemptId: 'wa9', refusals: 20 }]
    ;(run.nodeStates as { nodeId: string }[]).forEach((n) => {
      if (n.nodeId === 'repair')
        Object.assign(n, { state: 'ready', revision: 4, waitingFor: 'refusal_limit' })
    })
  })
  state.post = () => json(runSummary)
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  const card = await screen.findByRole('region', { name: 'Hermes refused Repair the draft' })
  expect(within(card).getByText(/refused this step 20 times/)).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: 'Try again' }))
  await waitFor(() =>
    expect(state.requests.some((r) => r.url.endsWith('/nodes/repair/try-again'))).toBe(true),
  )
  expect(
    JSON.parse(String(state.requests.find((r) => r.url.endsWith('/try-again'))!.init?.body)),
  ).toEqual({
    expectedNodeRevision: 4,
    orchestrationRevision: 14,
  })
})

test('a replaced agent shows the exact plan, and the decision carries the plan it showed; a changed plan is explained', async () => {
  state.snapshot = revisionOf((run) => {
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
  state.post = () => json({ error: { code: 'stale_plan', message: 'changed' } }, 409)
  mount(<WorkflowRunLive runId="wfrun-1" onStarted={started} />)
  const card = await screen.findByRole('region', { name: 'Replaced reviewer' })
  expect(within(card).getByText('old-incarnation')).toBeTruthy()
  expect(within(card).getByText('new-incarnation')).toBeTruthy()
  fireEvent.click(card.querySelector('summary')!)
  expect(within(card).getByText('Fix what the review found.')).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: 'Use the new reviewer for this run' }))
  await waitFor(() => expect(state.requests.some((r) => r.url.endsWith('/remap'))).toBe(true))
  expect(
    JSON.parse(String(state.requests.find((r) => r.url.endsWith('/remap'))!.init?.body)),
  ).toEqual({
    agentId: 'reviewer',
    frozenIncarnation: 'old-incarnation',
    currentIncarnation: 'new-incarnation',
    orchestrationRevision: 14,
    acknowledge: true,
    plan: [{ nodeId: 'repair', payloadHash: 'hash-1' }],
  })
  expect(await within(card).findByText(/What would be re-created changed/)).toBeTruthy()
})
