import { afterEach, expect, test } from 'vitest'
import { attachFakeLead } from '../../src/hermes/fake/fake-lead.ts'
import {
  agent,
  branch,
  definition,
  edge,
  end,
  join,
  node,
  run,
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

// The scripted fake adapter runs workflows exactly like the live executor, with markers in the step text.
// (The production wiring is `attachFakeLead(port, executor)` in fake mode, as in start-server.ts.)
async function fakeMode() {
  const harness = await wfHarness()
  attachFakeLead(harness.port, harness.orch)
  return harness
}

test('fake mode: a review loop branches on the scripted verdict and a failure routes to a repair', async () => {
  h = await fakeMode()
  const id = await start(
    h,
    definition(
      [
        agent('build', { onFailure: 'route', instruction: '[fake:fail] build it' }),
        agent('repair', { instruction: 'repair it' }),
        agent('review', { instruction: '[fake:verdict:changes_requested] review it' }),
        branch('route', 'review', [{ id: 'good', when: { kind: 'verdict', is: 'passed' } }]),
        agent('ship'),
        agent('rework'),
        join('merge'),
        end(),
      ],
      [
        edge('build', 'review'),
        edge('build', 'repair', 'failed'),
        edge('repair', 'review', 'ok'),
        edge('review', 'route'),
        edge('route', 'ship', 'good'),
        edge('route', 'rework', 'default'),
        edge('ship', 'merge'),
        edge('rework', 'merge'),
        edge('merge', 'done'),
      ],
    ),
  )
  await h.until(done(id), 240_000)
  expect(node(h, id, 'build').state).toBe('failed')
  expect(node(h, id, 'repair').state).toBe('succeeded')
  expect(node(h, id, 'review').verdict?.verdict).toBe('changes_requested')
  expect(node(h, id, 'rework').state).toBe('succeeded')
  expect(node(h, id, 'ship').state).toBe('skipped')
  expect(h.errors).toEqual([])
})

test('fake mode: a scripted outage is waited out without a new attempt', async () => {
  h = await fakeMode()
  const id = await start(
    h,
    definition([agent('a', { instruction: '[fake:refuse:2] go' }), end()], [edge('a', 'done')]),
  )
  await h.until(done(id), 240_000)
  expect(run(h, id).attempts).toHaveLength(1)
  expect(
    h.rows<{ refused_total: number }>('SELECT refused_total FROM orc_attempts')[0]!.refused_total,
  ).toBe(2)
})
