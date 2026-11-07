import { expect, test } from 'vitest'
import {
  db,
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

test('a signed call starts a job in the team room with its source, and the lead gets the quoted, redacted ticket', async () => {
  const { trigger, secret } = await create()
  expect(trigger.url).toMatch(new RegExp(`/hooks/${trigger.id}$`))
  const body = JSON.stringify(ticket)
  const answer = await call(trigger.id, secret, body)
  expect(answer.statusCode).toBe(200)
  const [job] = jobs()
  expect(answer.json()).toEqual({ ok: true, jobId: job!.id })
  expect(job!.title).toBe('TCK-142 · Login times out after 5 minutes')
  expect(JSON.parse(job!.source)).toEqual({
    app: 'Tickets app',
    ref: 'TCK-142',
    title: 'Login times out after 5 minutes',
    link: 'https://tickets.example.com/142',
    triggerId: trigger.id,
    missing: [],
  })
  const turn = db.sqlite
    .prepare('SELECT agent_id, input FROM message_runs WHERE job_id = ?')
    .get(job!.id) as { agent_id: string; input: string }
  expect(turn.agent_id).toBe('lead')
  expect(turn.input).not.toContain('sk-live-1234567890abcdef1234')
  expect(turn.input).toMatchSnapshot()
})

test('a call missing a mapped field still starts the job and says which', async () => {
  const { trigger, secret } = await create()
  const body = JSON.stringify({ ticket: { id: 'TCK-7' } })
  expect((await call(trigger.id, secret, body)).statusCode).toBe(200)
  const [job] = jobs()
  expect(JSON.parse(job!.source).missing).toEqual(['ticket.title', 'ticket.body', 'ticket.url'])
  const text = (
    db.sqlite
      .prepare("SELECT parts FROM messages WHERE job_id = ? AND author_kind = 'you'")
      .get(job!.id) as {
      parts: string
    }
  ).parts
  expect(text).toContain('The call had no ticket.title, ticket.body, ticket.url.')
})

test('repeating a webhook-id answers with the same job and starts nothing new', async () => {
  const { trigger, secret } = await create()
  const body = JSON.stringify(ticket)
  const first = (await call(trigger.id, secret, body)).json()
  const again = await call(trigger.id, secret, body)
  expect(again.json()).toEqual(first)
  expect(jobs()).toHaveLength(1)
  // 3.28.0: a new call while the team room's job runs waits as Next up; repeating it answers the same queue entry.
  const queued = await call(trigger.id, secret, body, { webhookId: 'msg_2' })
  expect(queued.statusCode).toBe(202)
  const again2 = await call(trigger.id, secret, body, { webhookId: 'msg_2' })
  expect(again2.statusCode).toBe(202)
  expect(again2.json().queueId).toBe(queued.json().queueId)
  expect(jobs()).toHaveLength(1)
})
