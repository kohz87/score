import { BridgeDecisionsResponseSchema } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApprovalOutbox } from '../../../src/domain/approval-outbox.ts'
import { readApprovalRow, readDelivery, approvalView } from '../../../src/domain/approval-store.ts'
import { createHermesPort } from '../../../src/hermes/index.ts'
import { event, hello, initialTime, setup } from './helpers.ts'

let env: ReturnType<typeof setup>
let token: string
let id: string
let now: number
let outbox: ApprovalOutbox
beforeEach(async () => {
  env = setup()
  now = initialTime
  outbox = new ApprovalOutbox({
    db: env.db,
    ingest: env.ingest,
    port: createHermesPort({ mode: 'fake', home: env.home, fakeSpeed: 1, fakeLoop: false }),
    clock: () => now,
  })
  token = await env.token()
  expect(
    (
      await env.send(token, [
        event(1, 'pre_approval_request', {
          gateId: 'gate-1',
          requestId: 'request-1',
          surface: 'gateway',
          command: 'rm demo/dist',
        }),
      ])
    ).statusCode,
  ).toBe(200)
  id = String(env.db.sqlite.prepare('SELECT id FROM approvals').get()!.id)
  const pair = await env.app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: env.app.pairing.createToken() },
  })
  const cookie = pair.headers['set-cookie']!.toString().split(';')[0]!
  expect(
    (
      await env.app.inject({
        method: 'POST',
        url: `/api/approvals/${id}/decision`,
        headers: { cookie, 'x-score-client': 'web' },
        payload: { choice: 'once' },
      })
    ).statusCode,
  ).toBe(202)
})
afterEach(async () => {
  await outbox.stop()
  await env.close()
})
function advance(ms: number) {
  now += ms
  env.setNow(now)
}
async function poll(producerToken = token, wait = 0) {
  const response = await env.app.inject({
    url: `/bridge/v1/decisions?wait=${wait}`,
    headers: env.headers(producerToken),
  })
  expect(response.statusCode).toBe(200)
  return BridgeDecisionsResponseSchema.parse(response.json()).items
}
function ack(
  deliveryId: string,
  leaseId: string,
  outcome: 'applied' | 'not_pending' | 'failed',
  producerToken = token,
  resolved = outcome === 'applied' ? 1 : 0,
) {
  return env.app.inject({
    method: 'POST',
    url: `/bridge/v1/decisions/${deliveryId}/ack`,
    headers: env.headers(producerToken),
    payload: { leaseId, outcome, resolved, error: 'password=must-not-store' },
  })
}
function view() {
  return approvalView(env.db.sqlite, readApprovalRow(env.db.sqlite, id)!, { now })
}

test('polls issue durable unique leases and refresh liveness; first not_pending preserves no decision', async () => {
  advance(1000)
  const [lease] = await poll()
  expect(lease).toMatchObject({
    requestId: 'request-1',
    sessionKey: 'gateway-session',
    choice: 'once',
    reason: null,
  })
  expect(await poll()).toEqual([])
  expect(readDelivery(env.db.sqlite, id)).toMatchObject({
    cycle_attempts: 1,
    maybe_applied: 1,
    state: 'delivering',
    lease_id: lease!.leaseId,
  })
  expect(env.db.sqlite.prepare('SELECT last_seen_at FROM producers').get()?.last_seen_at).toBe(
    new Date(now).toISOString(),
  )
  expect((await ack(lease!.deliveryId, lease!.leaseId, 'not_pending')).statusCode).toBe(204)
  expect(view()).toMatchObject({ status: 'pending', delivery: 'not_pending', decision: null })
})
test('stale negative ack ignored; late applied from any issued lease wins', async () => {
  const [first] = await poll()
  advance(30_001)
  const [second] = await poll()
  expect(second!.leaseId).not.toBe(first!.leaseId)
  expect((await ack(first!.deliveryId, first!.leaseId, 'failed')).statusCode).toBe(204)
  expect(readDelivery(env.db.sqlite, id)).toMatchObject({
    state: 'delivering',
    lease_id: second!.leaseId,
    cycle_attempts: 2,
  })
  expect((await ack(second!.deliveryId, second!.leaseId, 'not_pending')).statusCode).toBe(204)
  expect(view().delivery).toBe('unknown')
  expect((await ack(first!.deliveryId, first!.leaseId, 'applied')).statusCode).toBe(204)
  expect(view()).toMatchObject({ delivery: 'applied', decision: { by: 'you', choice: 'once' } })
  await ack(second!.deliveryId, second!.leaseId, 'failed')
  expect(view().delivery).toBe('applied')
})
test('failed receipts retry twice then become unknown and never store producer text', async () => {
  for (let i = 1; i <= 3; i++) {
    const [lease] = await poll()
    expect(lease).toBeDefined()
    expect((await ack(lease!.deliveryId, lease!.leaseId, 'failed')).statusCode).toBe(204)
    expect(readDelivery(env.db.sqlite, id)?.state).toBe(i < 3 ? 'intent' : 'unknown')
  }
  expect(
    JSON.stringify(env.db.sqlite.prepare('SELECT * FROM approval_deliveries').all()),
  ).not.toContain('must-not-store')
})
test('lost leases hit attempt budget after four claims', async () => {
  for (let i = 0; i < 4; i++) {
    expect(await poll()).toHaveLength(1)
    advance(30_001)
  }
  expect(await poll()).toEqual([])
  expect(view().delivery).toBe('unknown')
})
test('producer isolation and forged lease ids share the same 404', async () => {
  const [lease] = await poll()
  const other = await env.token({ ...hello, incarnation: 'worker-other', pid: 321 })
  expect(await poll(other)).toEqual([])
  const foreign = await ack(lease!.deliveryId, lease!.leaseId, 'applied', other)
  const forged = await ack(lease!.deliveryId, 'forged-lease', 'applied')
  const missing = await ack('missing', lease!.leaseId, 'applied')
  expect([foreign.statusCode, forged.statusCode, missing.statusCode]).toEqual([404, 404, 404])
  expect(foreign.body).toBe(forged.body)
  expect(missing.body).toBe(forged.body)
  expect(view().delivery).toBe('delivering')
})
test('applied requires resolved exactly one; auth and wait validation reuse bridge guards', async () => {
  const [lease] = await poll()
  expect((await ack(lease!.deliveryId, lease!.leaseId, 'applied', token, 0)).statusCode).toBe(400)
  expect((await ack(lease!.deliveryId, lease!.leaseId, 'applied', token, 2)).statusCode).toBe(400)
  expect(
    (await env.app.inject({ url: '/bridge/v1/decisions?wait=31', headers: env.headers(token) }))
      .statusCode,
  ).toBe(400)
  expect(
    (
      await env.app.inject({
        url: '/bridge/v1/decisions?wait=0',
        headers: env.headers(env.bootstrap),
      })
    ).statusCode,
  ).toBe(401)
  expect((await env.app.inject('/bridge/v1/decisions?wait=0')).statusCode).toBe(401)
})
test('sweep expires abandoned delivering leases; verified late positive receipt refines unknown', async () => {
  const [lease] = await poll()
  advance(120_001)
  await outbox.sweep()
  expect(view().delivery).toBe('unknown')
  expect((await ack(lease!.deliveryId, lease!.leaseId, 'applied')).statusCode).toBe(204)
  expect(view().delivery).toBe('applied')
})
test('expired intentions are terminated without issuing a lease', async () => {
  env.db.sqlite
    .prepare('UPDATE approvals SET expires_at = ? WHERE id = ?')
    .run(new Date(now).toISOString(), id)
  await outbox.sweep()
  expect(view().delivery).toBe('failed')
  expect(await poll()).toEqual([])
  expect(env.db.sqlite.prepare('SELECT * FROM approval_delivery_leases').all()).toEqual([])
})
test('expired active leases terminate even while the producer continues polling', async () => {
  await poll()
  env.db.sqlite
    .prepare('UPDATE approvals SET expires_at = ? WHERE id = ?')
    .run(new Date(now + 1000).toISOString(), id)
  advance(30_001)
  expect(await poll()).toEqual([])
  await outbox.sweep()
  expect(view().delivery).toBe('unknown')
})
test('long poll wakes on new decisions and respects timeout', async () => {
  await poll()
  const waiting = poll(token, 2)
  await new Promise((resolve) => setTimeout(resolve, 30))
  // A failed current receipt releases the same delivery for a fresh leased attempt and wakes its producer.
  const delivery = readDelivery(env.db.sqlite, id)!
  await ack(delivery.id, delivery.lease_id!, 'failed')
  const leases = await waiting
  expect(leases).toHaveLength(1)
  const started = performance.now()
  expect(await poll(token, 1)).toEqual([])
  expect(performance.now() - started).toBeGreaterThanOrEqual(900)
})
test('shutdown ends pending long polls cleanly', async () => {
  await poll()
  const waiting = poll(token, 30)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const close = env.app.close()
  expect(await waiting).toEqual([])
  await close
})
test('a long poll stops once the outbox notifier closes, instead of claiming in a loop until the bridge closes', async () => {
  // The app's own outbox this time, as in production (start-server shares it with the bridge listener).
  await outbox.stop()
  await env.close()
  let shared!: ApprovalOutbox
  env = setup({
    outbox: (deps) =>
      (shared = new ApprovalOutbox({
        ...deps,
        port: createHermesPort({ mode: 'fake', home: env.home, fakeSpeed: 1, fakeLoop: false }),
      })),
  })
  outbox = shared
  token = await env.token()
  const claims = vi.spyOn(shared, 'claimBridge')
  const waiting = poll(token, 30)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const started = performance.now()
  // Shutdown closes the notifier before the bridge listener (seen live: ~2,000 claims/s for ~20 s per restart).
  shared.notifier.close()
  expect(await waiting).toEqual([])
  expect(performance.now() - started).toBeLessThan(1000)
  expect(claims.mock.calls.length).toBeLessThanOrEqual(2)
})
test('a resolution signal before applied is upgraded to you; mismatched applied stays unknown', async () => {
  const [lease] = await poll()
  await env.send(token, [event(2, 'post_approval_response', { gateId: 'gate-1', choice: 'deny' })])
  await ack(lease!.deliveryId, lease!.leaseId, 'applied')
  expect(view()).toMatchObject({
    delivery: 'unknown',
    status: 'denied',
    decision: { by: 'elsewhere', choice: 'deny' },
  })
})

test('gate follow-up: an unqualified producer receives no decisions, even ones already queued for it', async () => {
  env.db.sqlite.prepare('UPDATE producers SET gateway_approvals = 0').run()
  expect(await poll()).toEqual([])
  expect(env.db.sqlite.prepare('SELECT state FROM approval_deliveries').get()).toEqual({
    state: 'intent',
  })
  env.db.sqlite.prepare('UPDATE producers SET gateway_approvals = 1').run()
  expect(await poll()).toHaveLength(1)
})

test('FT #4: nothing is leased to the plugin while Score holds all agent work, and the lease is issued once it lifts', async () => {
  let holding: string | null = 'Score is holding all agent work.'
  const port = createHermesPort({ mode: 'fake', home: env.home, fakeSpeed: 1, fakeLoop: false })
  Object.assign(port, { executionHold: () => holding })
  const held = new ApprovalOutbox({ db: env.db, ingest: env.ingest, port, clock: () => now })
  const producerId = String(env.db.sqlite.prepare('SELECT id FROM producers').get()!.id)
  expect(await held.claimBridge(producerId)).toEqual([])
  expect(readDelivery(env.db.sqlite, id)).toMatchObject({ state: 'intent', cycle_attempts: 0 })
  holding = null
  expect(await held.claimBridge(producerId)).toHaveLength(1)
  await held.stop()
})
