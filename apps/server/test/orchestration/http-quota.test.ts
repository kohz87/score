import { OrchestrationCreatedSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { boot, createBody, detail, h, post } from './http-helpers.ts'

test('8.6: the run’s quota floor is set at creation and in the limits; the quota answer is validated and guarded', async () => {
  await boot({
    script: byTurn({
      1: async (t) => {
        await t.call('orch.assign', { agent: 'builder', instruction: 'x' })
      },
    }),
  })
  expect(
    (await post('/api/orchestrations', createBody({ quotaFloorPercent: 51 }))).statusCode,
  ).toBe(400)
  const created = await post('/api/orchestrations', createBody({ quotaFloorPercent: 20 }))
  expect(created.statusCode).toBe(201)
  const id = OrchestrationCreatedSchema.parse(created.json()).orchestration.id
  expect(detail(id).quotaFloorPercent).toBe(20)
  await h.until(() => detail(id).gates.length === 1)
  const limits = await post(`/api/orchestrations/${id}/limits`, {
    quotaFloorPercent: null,
    orchestrationRevision: detail(id).revision,
  })
  expect(limits.statusCode, limits.body).toBe(200)
  expect(detail(id).quotaFloorPercent).toBeNull()
  const answer = (stepId: string, body: object) =>
    post(`/api/orchestrations/${id}/steps/${stepId}/quota`, {
      orchestrationRevision: detail(id).revision,
      ...body,
    })
  expect((await answer('s1', { answer: 'maybe' })).statusCode).toBe(400)
  expect((await answer('s99', { answer: 'wait' })).statusCode).toBe(404)
  // A step that isn't held for a low limit has nothing to answer.
  expect((await answer('s1', { answer: 'wait' })).statusCode).toBe(409)
  expect(
    (await post(`/api/orchestrations/${id}/steps/s1/quota`, { answer: 'wait' }, false)).statusCode,
  ).toBe(401)
})
