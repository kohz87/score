import { expect, test } from 'vitest'
import {
  db,
  headers,
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

const { create, call, jobs } = createWebhookTestHelpers(testState)
setupWebhooksTest(testState)

test('a payload with credential-named keys starts the job; the sample is valid JSON without the values', async () => {
  const { trigger, secret } = await create()
  const body = JSON.stringify({
    ticket: { id: 'TCK-9', title: 'Rotate keys' },
    password: 'hunter2',
    auth: { token: 'abc123' },
  })
  expect((await call(trigger.id, secret, body)).statusCode).toBe(200)
  const sample = (
    db.sqlite.prepare('SELECT sample FROM triggers WHERE id = ?').get(trigger.id) as {
      sample: string
    }
  ).sample
  expect(JSON.parse(sample)).toEqual({
    ticket: { id: 'TCK-9', title: 'Rotate keys' },
    password: '[redacted]',
    auth: { token: '[redacted]' },
  })
})

test('failed calls from a stranger don’t use up the real sender’s budget', async () => {
  const { trigger, secret } = await create()
  for (let i = 0; i < 70; i++)
    await call(trigger.id, 'whsec_' + 'B'.repeat(43) + '=', '{}', { webhookId: `bad_${i}` })
  expect(
    (await call(trigger.id, secret, JSON.stringify(ticket), { webhookId: 'real' })).statusCode,
  ).toBe(200)
})

test('a link must be http(s) and is redacted; template holes must sit inside strings', async () => {
  const { trigger, secret } = await create()
  const body = JSON.stringify({ ticket: { id: 'TCK-1', url: 'javascript:alert(1)' } })
  await call(trigger.id, secret, body)
  expect(JSON.parse(jobs()[0]!.source).link).toBeNull()
  const bad = await app.inject({
    method: 'POST',
    url: '/api/triggers',
    headers,
    payload: {
      ...TRIGGER,
      reportBack: { mode: 'fixed', tool: 'add_comment', args: '{"id": {{source.ref}}}' },
    },
  })
  expect(bad.statusCode).toBe(400)
  expect(bad.json().error.code).toBe('bad_template')
  const { renderArgs } = await import('../../src/domain/triggers/report-back.ts')
  expect(renderArgs('{"text":"{{source.ref}}"}', { 'source.ref': '1", "to": "x' })).toEqual({
    text: '1", "to": "x',
  })
})
