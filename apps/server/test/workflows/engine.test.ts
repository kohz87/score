import { afterEach, expect, test } from 'vitest'
import {
  agent,
  branch,
  decide,
  definition,
  edge,
  end,
  endRun,
  gate,
  join,
  node,
  nodeOf,
  openGate,
  replies,
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
const done = (id: string, status = 'succeeded') => (): boolean => run(h!, id).status === status

test('the smallest graph: agent → end succeeds with the graph at its end', async () => {
  h = await wfHarness()
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(done(id))
  const detail = run(h, id)
  expect(detail.graphOutcome).toBe('reached_end')
  expect(node(h, id, 'a').state).toBe('succeeded')
  expect(node(h, id, 'done').state).toBe('succeeded')
  expect(detail.tokens.every((t) => t.consumedBy !== null)).toBe(true)
  expect(h.errors).toEqual([])
})

test('a failure route: A --failed→ B runs even though A did not succeed', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [agent('a', { instruction: '[fake:hold] A', onFailure: 'route' }), agent('b'), end()],
      [edge('a', 'done'), edge('a', 'b', 'failed'), edge('b', 'done')],
    ),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined)
  await endRun(h, runIdOf(h, id, 'a')!, 'failed', 'it broke')
  await h.until(done(id))
  expect(node(h, id, 'a').state).toBe('failed')
  expect(node(h, id, 'b').state).toBe('succeeded')
  expect(run(h, id).graphOutcome).toBe('reached_end')
  // The executor never saw B as a dependent of A: B is a step with no `after`.
  expect(h.rows('SELECT after_steps FROM orc_steps WHERE id = ?', 's2')).toEqual([{ after_steps: '[]' }])
})

test('an unrouted failure fails the run and stops the other branches', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [agent('a', { instruction: '[fake:hold] A' }), agent('slow', { instruction: '[fake:hold] S' }), end()],
      [edge('a', 'done'), edge('slow', 'done')],
    ),
  )
  await h.until(() => runIdOf(h!, id, 'a') !== undefined && runIdOf(h!, id, 'slow') !== undefined)
  await endRun(h, runIdOf(h, id, 'a')!, 'failed', 'boom')
  await h.until(done(id, 'stopping'))
  // The run drains: it ends `failed` only once the other branch's attempt has real termination evidence.
  const slowAttempt = () => run(h!, id).attempts.find((x) => x.stepId === node(h!, id, 'slow').stepId)!
  expect(slowAttempt().stopRequestedAt).not.toBeNull()
  // Hermes' cancellation is not termination evidence: the attempt is unknown until the runtime reports an end.
  await h.until(() => slowAttempt().state === 'unknown')
  await endRun(h, slowAttempt().runId!, 'completed', 'late')
  await h.until(done(id, 'failed'))
  expect(run(h, id).graphOutcome).toBe('failed')
})

test('a rejected gate follows its rejected edge', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [gate('g', { onReject: 'route' }), agent('ship'), agent('rework'), end()],
      [edge('g', 'ship'), edge('g', 'rework', 'rejected'), edge('ship', 'done'), edge('rework', 'done')],
    ),
  )
  await h.until(() => node(h!, id, 'g').state === 'gate_open')
  await decide(h, id, 'g', 'reject')
  await h.until(done(id))
  expect(node(h, id, 'rework').state).toBe('succeeded')
  expect(node(h, id, 'ship').state).toBe('skipped')
})

test('a rejected gate without a route stops the run', async () => {
  h = await wfHarness()
  const id = await start(h, definition([gate('g'), agent('a'), end()], [edge('g', 'a'), edge('a', 'done')]))
  await h.until(() => node(h!, id, 'g').state === 'gate_open')
  await decide(h, id, 'g', 'reject')
  await h.until(done(id, 'stopped'))
  expect(run(h, id).graphOutcome).toBe('stopped')
  expect(node(h, id, 'a').state).toBe('cancelled')
})

test('a branch routes on the verdict and an untaken path delivers skips to a join', async () => {
  h = await wfHarness({
    orchestrator: {},
    reply: replies({
      review: 'Looks fine.\n```score-verdict\n{"verdict":"passed","reason":"ok"}\n```',
    }),
  })
  const id = await start(
    h,
    definition(
      [
        agent('review'),
        branch('route', 'review', [{ id: 'pass', when: { kind: 'verdict', is: 'passed' } }]),
        agent('ship'),
        agent('rework'),
        join('merge'),
        end(),
      ],
      [
        edge('review', 'route'),
        edge('route', 'ship', 'pass'),
        edge('route', 'rework', 'default'),
        edge('ship', 'merge'),
        edge('rework', 'merge'),
        edge('merge', 'done'),
      ],
    ),
  )
  await h.until(done(id))
  expect(node(h, id, 'review').verdict?.verdict).toBe('passed')
  expect(node(h, id, 'ship').state).toBe('succeeded')
  expect(node(h, id, 'rework').state).toBe('skipped')
  expect(node(h, id, 'merge').state).toBe('succeeded')
})

test('fan-out to two agents joined, then the end', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [agent('root'), agent('l'), agent('r'), join('merge'), end()],
      [edge('root', 'l'), edge('root', 'r'), edge('l', 'merge'), edge('r', 'merge'), edge('merge', 'done')],
    ),
  )
  await h.until(done(id))
  expect(['l', 'r'].map((n) => node(h!, id, n).state)).toEqual(['succeeded', 'succeeded'])
})

test('an early end beside a pending gate does not finish the run', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [agent('a'), gate('g'), agent('b'), end()],
      [edge('a', 'done'), edge('g', 'b'), edge('b', 'done')],
    ),
  )
  await h.until(() => node(h!, id, 'done').state === 'succeeded')
  await h.settle(2000)
  expect(run(h, id).status).toBe('running')
  expect(node(h, id, 'g').state).toBe('gate_open')
  await decide(h, id, 'g', 'approve')
  await h.until(done(id))
  expect(node(h, id, 'b').state).toBe('succeeded')
})

test('an early end beside work that waits for capacity does not finish the run', async () => {
  h = await wfHarness()
  const id = await start(
    h,
    definition(
      [agent('p'), agent('q', { instruction: '[fake:hold] Q' }), end()],
      [edge('p', 'done'), edge('q', 'done')],
    ),
    { maxConcurrentSteps: 1 },
  )
  await h.until(() => node(h!, id, 'p').state === 'succeeded')
  await h.settle(2000)
  expect(node(h, id, 'done').state).toBe('succeeded')
  expect(run(h, id).status).toBe('running')
  await h.until(() => runIdOf(h!, id, 'q') !== undefined)
  await endRun(h, runIdOf(h, id, 'q')!, 'completed', 'q done')
  await h.until(done(id))
  expect(nodeOf('(q: q)')).toBe('q')
})

test('every-step adds the executor assignment gate to each agent node; gates-only does not', async () => {
  h = await wfHarness()
  const gatesOnly = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(done(gatesOnly))
  expect(run(h, gatesOnly).assignmentGates).toHaveLength(0)
  const every = await start(h, definition([agent('a'), end()], [edge('a', 'done')]), {
    gatePolicy: 'every-step',
  })
  await h.until(() => node(h!, every, 'a').state === 'gate_open')
  const g = run(h, every).assignmentGates[0]!
  expect(g.nodeId).toBe('a')
  expect(g.payload.instruction).toContain('Do a')
  await decide(h, every, 'a', 'approve')
  await h.until(done(every))
})

test('openGate throws when nothing is open', async () => {
  h = await wfHarness()
  const id = await start(h, definition([agent('a'), end()], [edge('a', 'done')]))
  await h.until(done(id))
  expect(() => openGate(h!, id)).toThrow()
})
