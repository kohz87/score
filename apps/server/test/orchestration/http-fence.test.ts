import { GlobalFenceSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { boot, createBody, get, h, post } from './http-helpers.ts'

test('the fence routes: read, and lift needs a reviewed list and the current revision', async () => {
  await boot()
  expect(GlobalFenceSchema.parse((await get('/api/orchestrations/fence')).json()).fenced).toBe(
    false,
  )
  h.fence.set('journal_mismatch', [
    { kind: 'attempt', ref: 'ghost', journalN: 7, detail: 'in the journal only' },
  ])
  const fence = GlobalFenceSchema.parse((await get('/api/orchestrations/fence')).json())
  expect(fence).toMatchObject({
    fenced: true,
    reason: 'journal_mismatch',
    items: [{ kind: 'attempt', ref: 'ghost' }],
  })
  expect((await post('/api/orchestrations', createBody())).statusCode).toBe(409)
  expect((await post('/api/orchestrations', createBody())).json().error.code).toBe('fenced')
  expect(
    (
      await post('/api/orchestrations/fence/lift', {
        expectedRevision: fence.revision,
        reviewed: false,
      })
    ).statusCode,
  ).toBe(400)
  expect(
    (
      await post('/api/orchestrations/fence/lift', {
        expectedRevision: fence.revision + 1,
        reviewed: true,
      })
    ).statusCode,
  ).toBe(409)
  const lifted = await post('/api/orchestrations/fence/lift', {
    expectedRevision: fence.revision,
    reviewed: true,
    note: 'checked',
  })
  expect(lifted.statusCode).toBe(200)
  expect(GlobalFenceSchema.parse(lifted.json()).fenced).toBe(false)
  expect((await post('/api/orchestrations', createBody({ gatePolicy: 'none' }))).statusCode).toBe(
    201,
  )
  await h.settle(500)
  expect(
    h.rows<{ type: string }>("SELECT type FROM events WHERE type = 'orchestration.fence.updated'")
      .length,
  ).toBeGreaterThan(0)
})
