import { afterEach, expect, test } from 'vitest'
import {
  agent,
  decide,
  definition,
  edge,
  end,
  endRun,
  finishNode,
  gate,
  node,
  run,
  runIdOf,
  start,
  wfHarness,
  type Harness,
} from './wf-harness.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})
const done =
  (id: string, status = 'succeeded') =>
  (): boolean =>
    run(h!, id).status === status
const quiet = (): Promise<void> => h!.settle(1500)

test('Stop on a workflow run: gates and unstarted nodes end cancelled, the graph says stopped', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition([gate('g'), agent('a'), end()], [edge('g', 'a'), edge('a', 'done')]),
  )
  await h.until(() => node(h!, id, 'g').state === 'gate_open')
  await quiet()
  await h.orch.wfStop(id)
  await h.until(done(id, 'stopped'))
  const detail = run(h, id)
  expect(detail.graphOutcome).toBe('stopped')
  expect(detail.nodeGates[0]!.status).toBe('withdrawn')
  expect(['cancelled']).toContain(node(h, id, 'g').state)
  expect(node(h, id, 'a').state).toBe('cancelled')
  expect(detail.ownership).toBe('released')
  // The gate cannot be decided any more.
  await expect(
    h.orch.wfGateDecision(id, detail.nodeGates[0]!.id, {
      decision: 'approve',
      expectedRevision: detail.nodeGates[0]!.revision + 1,
      orchestrationRevision: detail.revision,
    }),
  ).rejects.toMatchObject({ status: 409 })
})

test('Stop on a run with a running step owes a Stop, drains, and ends stopped only with termination evidence', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition([agent('a', { instruction: '[fake:hold] A' }), end()], [edge('a', 'done')]),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  await h.orch.wfStop(id)
  await h.until(() => run(h!, id).attempts[0]!.state === 'unknown')
  expect(run(h, id).status).toBe('stopping')
  expect(run(h, id).ownership).toBe('owned')
  await endRun(h, run(h, id).attempts[0]!.runId!, 'completed', 'late')
  await h.until(done(id, 'stopped'))
})

test('while paused the graph still records results but issues nothing; Resume continues', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [agent('a', { instruction: '[fake:hold] A' }), agent('b'), end()],
      [edge('a', 'b'), edge('b', 'done')],
    ),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  await quiet()
  await h.orch.wfPause(id, { orchestrationRevision: run(h, id).revision })
  await finishNode(h, id, 'a', 'completed', 'a done')
  await h.until(() => node(h!, id, 'a').state === 'succeeded')
  await h.settle(5000)
  expect(node(h, id, 'b').state).toBe('ready')
  expect(node(h, id, 'b').stepId).toBeNull()
  expect(run(h, id).status).toBe('paused')
  await quiet()
  await h.orch.wfResume(id, { orchestrationRevision: run(h, id).revision })
  await h.until(done(id))
})

test('Retry and Try again are journaled as transitions that name their node', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [agent('a', { retries: 1, instruction: '[fake:hold] A' }), end()],
      [edge('a', 'done')],
    ),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  await finishNode(h, id, 'a', 'cancelled')
  await h.until(() => run(h!, id).attempts[0]!.state === 'unknown')
  await quiet()
  await h.orch.wfAbandon(id, {
    attemptIds: [run(h, id).attempts[0]!.id],
    orchestrationRevision: run(h, id).revision,
    acknowledge: true,
  })
  await h.until(() => node(h!, id, 'a').state === 'unresolved')
  await quiet()
  await h.orch.wfRetry(id, 'a', {
    expectedNodeRevision: node(h, id, 'a').revision,
    orchestrationRevision: run(h, id).revision,
    acknowledge: true,
  })
  const read = h.journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  expect(read.entries.filter((e) => e.kind === 'transition' && e.what === 'retry')).toMatchObject([
    { nodeId: 'a' },
  ])
})

test('a gate decision with a stale node, gate or run revision is a conflict', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition([gate('g'), agent('a'), end()], [edge('g', 'a'), edge('a', 'done')]),
  )
  await h.until(() => node(h!, id, 'g').state === 'gate_open')
  await quiet()
  const g = run(h, id).nodeGates[0]!
  await expect(
    h.orch.wfGateDecision(id, g.id, {
      decision: 'approve',
      expectedRevision: g.revision + 1,
      orchestrationRevision: run(h, id).revision,
    }),
  ).rejects.toMatchObject({ code: 'conflict' })
  await expect(
    h.orch.wfGateDecision(id, g.id, {
      decision: 'approve',
      expectedRevision: g.revision,
      orchestrationRevision: run(h, id).revision + 5,
    }),
  ).rejects.toMatchObject({ code: 'conflict' })
  await decide(h, id, 'g', 'approve')
  // The same decision twice: the second finds it closed.
  await expect(
    h.orch.wfGateDecision(id, g.id, {
      decision: 'approve',
      expectedRevision: g.revision,
      orchestrationRevision: run(h, id).revision,
    }),
  ).rejects.toMatchObject({ status: 409 })
  await h.until(done(id))
})

test('the gate shows the consumed ancestor results with their revisions', async () => {
  h = await wfHarness({ reply: () => ({ text: 'WORK PRODUCT', tools: [] }) })
  const id = await start(
    h,
    definition([agent('a'), gate('g'), end()], [edge('a', 'g'), edge('g', 'done')]),
  )
  await h.until(() => node(h!, id, 'g').state === 'gate_open')
  const g = run(h, id).nodeGates[0]!
  expect(g.payload.consumed).toEqual([
    {
      nodeId: 'a',
      outputRevision: node(h, id, 'a').outputRevision,
      output: 'WORK PRODUCT',
      truncated: false,
    },
  ])
  expect(g.payload.question).toBe('OK g?')
  await decide(h, id, 'g', 'approve')
  await h.until(done(id))
})
