import { expect, test } from 'vitest'
import { TRIGGER_LIMITS } from '@score/contract'
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

test('a trigger’s jobs start with a spend cap, and a trigger can hold only so many open jobs', async () => {
  const { trigger, secret } = await create()
  const body = JSON.stringify(ticket)
  // 3.28.0: the first call starts a job; the rest wait behind it (Next up) and count as open.
  for (let i = 0; i < TRIGGER_LIMITS.openJobs; i++)
    expect((await call(trigger.id, secret, body, { webhookId: `open_${i}` })).statusCode).toBe(
      i === 0 ? 200 : 202,
    )
  const caps = db.sqlite
    .prepare('SELECT DISTINCT spend_cap_usd AS cap FROM jobs WHERE source IS NOT NULL')
    .all() as { cap: number }[]
  expect(caps).toEqual([{ cap: TRIGGER_LIMITS.jobSpendCapUsd }])
  const busy = await call(trigger.id, secret, body, { webhookId: 'one_too_many' })
  expect(busy.statusCode).toBe(429)
  expect(busy.json().error.code).toBe('trigger_busy')
  expect(jobs()).toHaveLength(1)
  // Finishing one makes room again: the new call goes to the back, and the oldest waiting call starts.
  db.sqlite.prepare("UPDATE jobs SET state = 'done' WHERE id = ?").run(jobs()[0]!.id)
  expect((await call(trigger.id, secret, body, { webhookId: 'after_done' })).statusCode).toBe(202)
  expect(jobs()).toHaveLength(2)
  const started = db.sqlite
    .prepare('SELECT webhook_id FROM trigger_calls WHERE job_id = ?')
    .get(jobs()[1]!.id) as { webhook_id: string }
  expect(started.webhook_id).toBe('open_1')
})

test('spraying random trigger ids from one address shares one failure budget', async () => {
  const random = () => 'trg_' + Math.random().toString(16).slice(2).padEnd(24, '0').slice(0, 24)
  const answers: number[] = []
  for (let i = 0; i < TRIGGER_LIMITS.callsPerMinute + 5; i++)
    answers.push((await call(random(), 'whsec_' + 'B'.repeat(43) + '=', '{}')).statusCode)
  expect(answers.slice(0, TRIGGER_LIMITS.callsPerMinute).every((status) => status === 404)).toBe(
    true,
  )
  expect(answers.slice(TRIGGER_LIMITS.callsPerMinute)).toEqual(Array(5).fill(429))
})

test('a retried create answers with the same trigger and secret; a different one, or a later one, is new', async () => {
  const first = await create()
  const retry = await create()
  expect(retry.trigger.id).toBe(first.trigger.id)
  expect(retry.secret).toBe(first.secret)
  const other = await app.inject({
    method: 'POST',
    url: '/api/triggers',
    headers,
    payload: { ...TRIGGER, name: 'Another' },
  })
  expect(other.json().trigger.id).not.toBe(first.trigger.id)
  now += 11 * 60_000
  expect((await create()).trigger.id).not.toBe(first.trigger.id)
  const list = await app.inject({ method: 'GET', url: '/api/triggers', headers })
  expect(list.json().items).toHaveLength(3)
})
