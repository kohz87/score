import { ApprovalSchema } from '@score/contract'
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { expireApprovals } from '../../src/domain/approvals.ts'
import { readDelivery } from '../../src/domain/approval-store.ts'
import { ApprovalDeliveryError } from '../../src/hermes/index.ts'
import {
  advance,
  cookie,
  decide,
  deliver,
  env,
  installApprovalHarness,
  intent,
  now,
  outbox,
  request,
  signalChoice,
  view,
} from './approvals-helpers.ts'

installApprovalHarness()

test('human guard and CSRF; concurrent decisions accept exactly one and include current details', async () => {
  const id = await request()
  expect((await decide(id, 'once', { cookie: '', 'x-score-client': 'web' })).statusCode).toBe(401)
  expect((await decide(id, 'once', { cookie, 'x-score-client': '' })).statusCode).toBe(403)
  const results = await Promise.all([decide(id), decide(id)])
  expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409])
  const accepted = ApprovalSchema.parse(results.find((r) => r.statusCode === 202)!.json())
  expect(accepted.delivery).toBe('intent')
  expect(accepted.decision).toBeNull()
  expect(
    ApprovalSchema.parse(results.find((r) => r.statusCode === 409)!.json().error.details).id,
  ).toBe(id)
  expect((await decide(id, 'deny')).statusCode).toBe(409)
  expect(readDelivery(env.db.sqlite, id)?.note).toBe('password=[redacted]')
})

test('validation, hidden and missing ids, feature disabled, offered choices', async () => {
  const id = await request('limited', { choices: ['once', 'deny'] })
  expect((await decide(id, 'always')).json().error.code).toBe('validation_error')
  expect((await decide('missing')).statusCode).toBe(404)
  env.db.sqlite.prepare('UPDATE approvals SET visible = 0 WHERE id = ?').run(id)
  expect((await decide(id)).statusCode).toBe(404)
  env.db.sqlite.prepare('UPDATE approvals SET visible = 1 WHERE id = ?').run(id)
  env.disable(['score-runs'])
  expect((await decide(id)).statusCode).toBe(403)
})

test.each(['no_request', 'coalesced', 'inactive_run', 'guardian'] as const)(
  'rejects non-actionable %s',
  async (kind) => {
    const id = await request()
    if (kind === 'no_request')
      env.db.sqlite.prepare('UPDATE approvals SET request_id = NULL WHERE id = ?').run(id)
    if (kind === 'coalesced')
      env.db.sqlite.prepare('UPDATE approvals SET coalesced = 1 WHERE id = ?').run(id)
    if (kind === 'inactive_run') env.db.sqlite.prepare(`UPDATE runs SET status = 'completed'`).run()
    if (kind === 'guardian')
      env.db.sqlite
        .prepare(
          `UPDATE approvals SET stage = 'guardian', phase = 'guardian_evaluating' WHERE id = ?`,
        )
        .run(id)
    expect((await decide(id)).statusCode).toBe(409)
  },
)

test('elsewhere decision arriving during delivery plus not_pending never becomes denial', async () => {
  const id = await request()
  await intent(id)
  deliver.mockImplementationOnce(async () => {
    await signalChoice(id, 'once')
    return 'not_pending'
  })
  await outbox.runOnce()
  expect(view(id)).toMatchObject({
    status: 'approved',
    delivery: 'not_pending',
    decision: { choice: 'once', by: 'elsewhere' },
  })
})
test.each(['before', 'after'] as const)(
  'a matching signal %s applied attributes only confirmed delivery to you',
  async (order) => {
    const id = await request()
    await intent(id)
    if (order === 'before')
      deliver.mockImplementationOnce(async () => {
        await signalChoice(id, 'once')
        return 'applied'
      })
    await outbox.runOnce()
    if (order === 'after') await signalChoice(id, 'once')
    expect(view(id)).toMatchObject({ delivery: 'applied', decision: { choice: 'once', by: 'you' } })
  },
)
test('a mismatching confirmed delivery preserves the recorded decision and becomes unknown', async () => {
  const id = await request()
  await intent(id)
  deliver.mockImplementationOnce(async () => {
    await signalChoice(id, 'deny')
    return 'applied'
  })
  await outbox.runOnce()
  expect(view(id)).toMatchObject({
    status: 'denied',
    delivery: 'unknown',
    decision: { choice: 'deny', by: 'elsewhere' },
  })
})

test.each(['intent', 'delivering'] as const)(
  'restart recovers %s; uncertain delivery cannot become not_pending',
  async (state) => {
    const id = await request()
    await intent(id)
    env.db.sqlite
      .prepare('UPDATE approval_deliveries SET state = ? WHERE approval_id = ?')
      .run(state, id)
    deliver.mockResolvedValueOnce(state === 'intent' ? 'applied' : 'not_pending')
    await outbox.start()
    await outbox.runOnce()
    expect(view(id).delivery).toBe(state === 'intent' ? 'applied' : 'unknown')
    if (state === 'delivering') expect(readDelivery(env.db.sqlite, id)?.maybe_applied).toBe(1)
  },
)
test('lost response then not_pending remains unknown', async () => {
  const id = await request()
  await intent(id)
  deliver
    .mockRejectedValueOnce(new ApprovalDeliveryError('transport_error', true, true))
    .mockResolvedValueOnce('not_pending')
  await outbox.runOnce()
  expect(readDelivery(env.db.sqlite, id)).toMatchObject({
    state: 'intent',
    maybe_applied: 1,
    cycle_attempts: 1,
  })
  advance(1000)
  await outbox.runOnce()
  expect(view(id)).toMatchObject({ delivery: 'unknown', decision: null, status: 'pending' })
})
test('never-sent failures exhaust four attempts; manual retry keeps choice and starts a new cycle', async () => {
  const id = await request()
  await intent(id)
  deliver.mockRejectedValue(new ApprovalDeliveryError('transport_error', false, true))
  for (const delay of [0, 1000, 5000, 30_000]) {
    advance(delay)
    await outbox.runOnce()
  }
  expect(readDelivery(env.db.sqlite, id)).toMatchObject({
    state: 'failed',
    maybe_applied: 0,
    cycle_attempts: 4,
  })
  expect((await decide(id, 'deny')).statusCode).toBe(409)
  expect((await decide(id)).statusCode).toBe(202)
  expect(readDelivery(env.db.sqlite, id)).toMatchObject({
    state: 'intent',
    cycle: 2,
    cycle_attempts: 0,
  })
})
test('expired intentions are never dispatched, and late choices beat closure', async () => {
  const id = await request('expired', { expiresAt: new Date(now + 1000).toISOString() })
  await intent(id)
  advance(1000)
  await env.ingest.submit({
    source: 'test',
    identity: randomUUID(),
    apply: ({ sqlite, now: at }) => expireApprovals(sqlite, at),
  })
  await outbox.runOnce()
  expect(deliver).not.toHaveBeenCalled()
  expect(view(id)).toMatchObject({ phase: 'expired', delivery: 'failed' })
  await signalChoice(id, 'once')
  expect(view(id)).toMatchObject({
    phase: 'decided',
    status: 'approved',
    decision: { by: 'elsewhere' },
  })
})
