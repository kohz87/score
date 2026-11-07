import { expect, test } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { signWebhook } from '../../src/domain/triggers/signature.ts'
import {
  db,
  headers,
  home,
  ingest,
  port,
  TRIGGER,
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

const { create, call, start } = createWebhookTestHelpers(testState)
setupWebhooksTest(testState)

test('the secret is sealed at rest and shown again only to a paired browser', async () => {
  const { trigger, secret } = await create()
  const stored = JSON.stringify(db.sqlite.prepare('SELECT * FROM triggers').all())
  expect(stored).not.toContain(secret.slice(6))
  expect(readFileSync(join(home, 'score.db')).includes(Buffer.from(secret.slice(6)))).toBe(false)
  const again = await app.inject({ url: `/api/triggers/${trigger.id}/secret`, headers })
  expect(again.json()).toEqual({ secret })
  const unpaired = await app.inject({
    url: `/api/triggers/${trigger.id}/secret`,
    headers: { 'x-score-client': 'web' },
  })
  expect(unpaired.statusCode).toBe(401)
  const rotated = (
    await app.inject({ method: 'POST', url: `/api/triggers/${trigger.id}/rotate`, headers })
  ).json() as { secret: string }
  expect(rotated.secret).not.toBe(secret)
  expect((await call(trigger.id, secret, '{}', { webhookId: 'old_secret' })).statusCode).toBe(401)
  expect(
    (await call(trigger.id, rotated.secret, '{}', { webhookId: 'new_secret' })).statusCode,
  ).toBe(200)
})

test('remote mode: a webhook call needs no pairing; everything else about triggers still does', async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(home, { recursive: true, force: true })
  const origin = 'https://score.lan:8741'
  await start({
    SCORE_REMOTE: '1',
    SCORE_TLS_CERT: '/tmp/cert',
    SCORE_TLS_KEY: '/tmp/key',
    SCORE_PUBLIC_ORIGINS: origin,
  })
  const { createTrigger } = await import('../../src/domain/triggers/triggers.ts')
  const { loadSealingKey, sealer } = await import('../../src/auth/sealing.ts')
  const made = db.tx((sqlite) =>
    createTrigger(
      sqlite,
      sealer(loadSealingKey(home)),
      { ...TRIGGER, reportBack: { mode: 'off' } },
      origin,
      new Date(now).toISOString(),
    ),
  )
  expect(made.trigger.url).toBe(`${origin}/hooks/${made.trigger.id}`)
  const body = JSON.stringify(ticket)
  const at = Math.floor(now / 1000)
  const hook = await app.inject({
    method: 'POST',
    url: `/hooks/${made.trigger.id}`,
    headers: {
      host: 'score.lan:8741',
      'content-type': 'application/json',
      'webhook-id': 'msg_r',
      'webhook-timestamp': String(at),
      'webhook-signature': signWebhook(made.secret, 'msg_r', at, body),
    },
    payload: body,
  })
  expect(hook.statusCode).toBe(200)
  const remote = { host: 'score.lan:8741', origin, 'x-score-client': 'web' }
  expect((await app.inject({ url: '/api/triggers', headers: remote })).statusCode).toBe(401)
  expect(
    (await app.inject({ url: `/api/triggers/${made.trigger.id}/secret`, headers: remote }))
      .statusCode,
  ).toBe(401)
  // Only POST to a trigger's exact path reaches the route; a GET is just an unknown app page (no data).
  expect(
    (await app.inject({ url: `/hooks/${made.trigger.id}`, headers: { host: 'score.lan:8741' } }))
      .statusCode,
  ).toBe(404)
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/hooks/anything-else',
        headers: { host: 'score.lan:8741' },
        payload: '{}',
      })
    ).statusCode,
  ).toBe(401)
})
