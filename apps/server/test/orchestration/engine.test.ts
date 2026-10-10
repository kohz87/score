import { afterEach, beforeEach, expect, test } from 'vitest'
import { harness, type Harness } from './harness.ts'

let h: Harness
beforeEach(async () => {
  h = await harness()
})
afterEach(async () => {
  await h.close()
})

const status = (id: string) => h.orch.summary(id).status

test('the event loop: lead plans, steps run in order, the lead is woken and finishes', async () => {
  const id = await h.create()
  await h.until(() => status(id) === 'succeeded')
  const detail = h.orch.snapshot(id).orchestration
  expect(detail.stepsList.map((step) => [step.id, step.status])).toEqual([
    ['s1', 'succeeded'],
    ['s2', 'succeeded'],
  ])
  // s2 started only after s1 had succeeded.
  expect(detail.stepsList[1]!.after).toEqual(['s1'])
  expect(detail.attempts.filter((a) => a.kind === 'lead').length).toBe(3)
  expect(detail.attempts.every((a) => a.state === 'terminated' && a.evidence === 'completed')).toBe(true)
  expect(detail.finish?.outcome).toBe('success')
  expect(detail.ownership).toBe('released')
})
