import { afterEach, beforeEach, expect, test } from 'vitest'
import { createHarness, type Harness } from '../../fixtures/kanban/harness.ts'

let h: Harness
beforeEach(() => {
  h = createHarness()
})
afterEach(async () => {
  await h.close()
})

test('smoke: baseline then tail projects an attempt', async () => {
  h.board.task('t_a')
  const coordinator = h.make()
  await h.poll(coordinator, 3)
  expect(h.histories()).toHaveLength(1)
  h.board.tick()
  const run = h.board.claim('t_a')
  await h.poll(coordinator, 2)
  expect(h.attempt(run)).toMatchObject({ status: 'running', evidence: 'proven', role: 'implementer', profile: 'builder' })
  h.board.tick(5)
  h.board.end('t_a', { outcome: 'completed', status: 'done', summary: 'ok' })
  await h.poll(coordinator, 2)
  expect(h.attempt(run)).toMatchObject({ status: 'completed', revision: 2 })
})
