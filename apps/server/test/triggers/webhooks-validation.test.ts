import { expect, test } from 'vitest'
import {
  headers,
  ticket,
  createWebhookTestHelpers,
  setupWebhooksTest,
  type WebhooksTestState,
} from './webhooks-helpers.ts'

let app: WebhooksTestState['app']
let now: WebhooksTestState['now']
const testState: WebhooksTestState = {
  get app() {
    return app
  },
  set app(value) {
    app = value
  },
  get now() {
    return now
  },
  set now(value) {
    now = value
  },
}

const { create, call, jobs } = createWebhookTestHelpers(testState)
setupWebhooksTest(testState)

test('only valid signatures within five minutes are accepted', async () => {
  const { trigger, secret } = await create()
  const body = JSON.stringify(ticket)
  const at = Math.floor(now / 1000)
  expect((await call(trigger.id, secret, body, { at: at - 301 })).statusCode).toBe(401)
  expect((await call(trigger.id, secret, body, { at: at + 301 })).statusCode).toBe(401)
  expect((await call(trigger.id, 'whsec_' + 'A'.repeat(43) + '=', body)).statusCode).toBe(401)
  expect((await call(trigger.id, secret, body, { signature: 'v1,' })).statusCode).toBe(401)
  expect((await call(trigger.id, secret, body, { at: at - 299 })).statusCode).toBe(200)
  expect(jobs()).toHaveLength(1)
})

test('non-JSON, oversized and too frequent calls are refused; unknown and deleted triggers too', async () => {
  const { trigger, secret } = await create()
  expect((await call(trigger.id, secret, 'hello', { type: 'text/plain' })).statusCode).toBe(415)
  expect((await call(trigger.id, secret, 'not json')).statusCode).toBe(415)
  const huge = JSON.stringify({ blob: 'x'.repeat(256 * 1024) })
  expect((await call(trigger.id, secret, huge)).statusCode).toBe(413)
  expect((await call('trg_000000000000000000000000', secret, '{}')).statusCode).toBe(404)
  // 60 verified calls a minute per trigger; the signed non-JSON call above was one of them.
  for (let i = 0; i < 59; i++) await call(trigger.id, secret, '{}', { webhookId: `rate_${i}` })
  expect((await call(trigger.id, secret, '{}', { webhookId: 'one_too_many' })).statusCode).toBe(429)
  now += 61_000
  expect(
    (await app.inject({ method: 'DELETE', url: `/api/triggers/${trigger.id}`, headers }))
      .statusCode,
  ).toBe(204)
  expect((await call(trigger.id, secret, '{}', { webhookId: 'after_delete' })).statusCode).toBe(410)
})
