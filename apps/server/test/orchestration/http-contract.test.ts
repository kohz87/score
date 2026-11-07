import {
  OrchestrationCreatedSchema,
  OrchestrationListSchema,
  OrchestrationSnapshotSchema,
  OrchestrationSummarySchema,
  PreflightSchema,
} from '@score/contract'
import { expect, test } from 'vitest'
import { byTurn } from '../../src/hermes/fake/fake-lead.ts'
import { boot, createBody, detail, get, h, post, status } from './http-helpers.ts'

test('preflight, create, list and snapshot follow the contract', async () => {
  await boot({
    script: byTurn({
      1: async (t) => {
        await t.call('orch.assign', { agent: 'builder', instruction: 'x' })
      },
    }),
  })
  const preflight = PreflightSchema.parse(
    (
      await get('/api/orchestrations/preflight?leadAgentId=lead&allowedAgents=builder,reviewer')
    ).json(),
  )
  expect(preflight.ok).toBe(true)
  expect(preflight.checks.map((c) => c.id)).toContain('tool_readiness')
  const bad = PreflightSchema.parse(
    (await get('/api/orchestrations/preflight?leadAgentId=lead&allowedAgents=lead')).json(),
  )
  expect(bad.ok).toBe(false)
  expect(bad.checks.find((c) => c.id === 'allowed_agents')!.message).toContain(
    'cannot also do steps',
  )

  expect((await post('/api/orchestrations', createBody(), false)).statusCode).toBe(401)
  expect(
    (await post('/api/orchestrations', createBody({ acknowledgement: { text: 'sure' } })))
      .statusCode,
  ).toBe(400)
  expect(
    (await post('/api/orchestrations', createBody({ allowedAgents: ['lead'] }))).statusCode,
  ).toBe(409)
  const created = await post('/api/orchestrations', createBody(), true, 'k1')
  expect(created.statusCode).toBe(201)
  const body = OrchestrationCreatedSchema.parse(created.json())
  const again = await post('/api/orchestrations', createBody(), true, 'k1')
  expect(OrchestrationCreatedSchema.parse(again.json()).orchestration.id).toBe(
    body.orchestration.id,
  )
  expect(h.orch.list().items).toHaveLength(1)

  await h.until(() => detail(body.orchestration.id).gates.length === 1)
  const list = OrchestrationListSchema.parse((await get('/api/orchestrations')).json())
  expect(list.items[0]!.needsYou).toContainEqual({ kind: 'gate', gateId: 'g1', stepId: 's1' })
  const snap = OrchestrationSnapshotSchema.parse(
    (await get(`/api/orchestrations/${body.orchestration.id}`)).json(),
  )
  expect(snap.asOfSeq).toBeGreaterThan(0)
  expect(snap.orchestration.stepsList[0]!.instruction).toBe('x')
  expect((await get('/api/orchestrations/nope')).statusCode).toBe(404)
  // Events reached the stream log.
  const types = h.rows<{ type: string }>('SELECT DISTINCT type FROM events').map((row) => row.type)
  expect(types).toContain('orchestration.upserted')
  expect(types).toContain('brief.upserted')
})

test('decisions need the paired session and the revision the page showed', async () => {
  await boot({
    script: byTurn({
      1: async (t) => {
        await t.call('orch.assign', { agent: 'builder', instruction: 'x' })
        await t.call('orch.ask', { question: 'q?' })
      },
    }),
  })
  const id = OrchestrationCreatedSchema.parse(
    (await post('/api/orchestrations', createBody())).json(),
  ).orchestration.id
  await h.until(() => detail(id).gates.length === 1 && detail(id).inquiries.length === 1)
  const rev = detail(id).revision
  const gate = { decision: 'approve', expectedRevision: 1, orchestrationRevision: rev }
  expect((await post(`/api/orchestrations/${id}/gates/g1/decision`, gate, false)).statusCode).toBe(
    401,
  )
  const stale = await post(`/api/orchestrations/${id}/gates/g1/decision`, {
    ...gate,
    orchestrationRevision: rev - 1,
  })
  expect(stale.statusCode).toBe(409)
  expect(stale.json().error.code).toBe('conflict')
  expect(stale.json().error.details.currentRevision).toBe(rev)
  expect(
    (await post(`/api/orchestrations/${id}/gates/g1/decision`, { decision: 'maybe' })).statusCode,
  ).toBe(400)
  const answered = await post(`/api/orchestrations/${id}/inquiries/q1/answer`, {
    answer: 'blue',
    expectedRevision: 1,
    orchestrationRevision: rev,
  })
  expect(answered.statusCode).toBe(200)
  expect(OrchestrationSummarySchema.parse(answered.json()).needsYou).not.toContainEqual({
    kind: 'inquiry',
    inquiryId: 'q1',
  })
  // The gate decision now needs the new run revision.
  const ok = await post(`/api/orchestrations/${id}/gates/g1/decision`, {
    ...gate,
    orchestrationRevision: detail(id).revision,
  })
  expect(ok.statusCode).toBe(200)
  expect(
    (
      await post(`/api/orchestrations/${id}/waiver`, {
        orchestrationRevision: detail(id).revision,
        acknowledge: true,
      })
    ).statusCode,
  ).toBe(409)
  expect(
    (await post(`/api/orchestrations/${id}/pause`, { orchestrationRevision: detail(id).revision }))
      .statusCode,
  ).toBe(200)
  expect(status(id)).toBe('paused')
  expect(
    (await post(`/api/orchestrations/${id}/resume`, { orchestrationRevision: detail(id).revision }))
      .statusCode,
  ).toBe(200)
  // Stop ignores a stale page.
  expect(
    (await post(`/api/orchestrations/${id}/stop`, { orchestrationRevision: 1 })).statusCode,
  ).toBe(200)
  expect(['stopping', 'stopped']).toContain(status(id))
})
