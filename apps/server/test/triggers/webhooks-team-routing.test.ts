import { expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
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

const { create, call, jobs } = createWebhookTestHelpers(testState)
setupWebhooksTest(testState)

// 3.6.0 (decision 137): a trigger can start its jobs in a chosen team.
test('a trigger starts its jobs in its chosen team; deleting that team sends them to the first team room', async () => {
  const team = await app.inject({
    method: 'POST',
    url: '/api/team-rooms',
    headers: { ...headers, 'idempotency-key': 'team-1' },
    payload: { name: 'Support', members: ['builder'], leadAgentId: 'builder' },
  })
  expect(team.statusCode).toBe(201)
  const teamId = (team.json() as { id: string }).id
  const made = await app.inject({
    method: 'POST',
    url: '/api/triggers',
    headers,
    payload: { ...TRIGGER, teamRoomId: teamId },
  })
  expect(made.statusCode).toBe(201)
  const { trigger, secret } = made.json() as {
    trigger: { id: string; teamRoomId: string | null }
    secret: string
  }
  expect(trigger.teamRoomId).toBe(teamId)
  expect((await call(trigger.id, secret, JSON.stringify(ticket))).statusCode).toBe(200)
  const room = (jobId: string) =>
    (db.sqlite.prepare('SELECT room_id FROM jobs WHERE id = ?').get(jobId) as { room_id: string })
      .room_id
  expect(room(jobs()[0]!.id)).toBe(teamId)
  // The team's lead, not the first team room's, gets the turn.
  const turn = db.sqlite
    .prepare('SELECT agent_id FROM message_runs WHERE job_id = ?')
    .get(jobs()[0]!.id) as { agent_id: string }
  expect(turn.agent_id).toBe('builder')

  // Only a team room can be chosen.
  const plain = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: { ...headers, 'idempotency-key': 'room-1' },
    payload: { name: 'ops' },
  })
  const refused = await app.inject({
    method: 'PATCH',
    url: `/api/triggers/${trigger.id}`,
    headers,
    payload: { teamRoomId: (plain.json() as { id: string }).id },
  })
  expect(refused.statusCode).toBe(400)

  // An archived team can't be chosen, and a call while the chosen team is archived goes to the first team room.
  db.sqlite.prepare('UPDATE rooms SET archived = 1 WHERE id = ?').run(teamId)
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${trigger.id}`,
        headers,
        payload: { teamRoomId: teamId },
      })
    ).statusCode,
  ).toBe(400)
  expect(
    (
      await call(
        trigger.id,
        secret,
        JSON.stringify({ ticket: { ...ticket.ticket, id: 'TCK-3' } }),
        {
          webhookId: 'msg_3',
        },
      )
    ).statusCode,
  ).toBe(200)
  const everyone = db.sqlite
    .prepare("SELECT id FROM rooms WHERE role = 'team' AND team_everyone = 1")
    .get() as { id: string }
  expect(room(jobs().at(-1)!.id)).toBe(everyone.id)
  db.sqlite.prepare('UPDATE rooms SET archived = 0 WHERE id = ?').run(teamId)

  // Deleting the team (after its job is closed) sends the trigger back to the first team room.
  db.sqlite.prepare("UPDATE jobs SET state = 'closed' WHERE room_id = ?").run(teamId)
  db.sqlite
    .prepare(
      "UPDATE message_runs SET state = 'completed' WHERE room_id = ? AND state IN ('pending', 'active')",
    )
    .run(teamId)
  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/rooms/${teamId}`,
    headers: { ...headers, 'idempotency-key': 'del-1' },
    payload: { confirm: 'Support' },
  })
  expect(deleted.statusCode, deleted.body).toBe(204)
  const listed = (await app.inject({ method: 'GET', url: '/api/triggers', headers })).json() as {
    items: { id: string; teamRoomId: string | null }[]
  }
  expect(listed.items.find((item) => item.id === trigger.id)!.teamRoomId).toBeNull()
  // 3.28.0: the first team room runs one job at a time; its job from the archived-team call ends first.
  db.sqlite
    .prepare(
      "UPDATE jobs SET state = 'closed' WHERE room_id = (SELECT id FROM rooms WHERE role = 'team' AND team_everyone = 1)",
    )
    .run()
  expect(
    (
      await call(
        trigger.id,
        secret,
        JSON.stringify({ ticket: { ...ticket.ticket, id: 'TCK-2' } }),
        {
          webhookId: 'msg_2',
        },
      )
    ).statusCode,
  ).toBe(200)
  const first = db.sqlite
    .prepare("SELECT id FROM rooms WHERE role = 'team' AND team_everyone = 1")
    .get() as {
    id: string
  }
  expect(room(jobs().at(-1)!.id)).toBe(first.id)
})

test('3.28.0: a call while the team room’s job runs waits as Next up, starts when the job ends, and can be skipped', async () => {
  const { trigger, secret } = await create()
  const body = (id: string) => JSON.stringify({ ticket: { ...ticket.ticket, id } })
  expect((await call(trigger.id, secret, body('TCK-A'), { webhookId: 'a' })).statusCode).toBe(200)
  const first = jobs()[0]!
  const waiting = await call(trigger.id, secret, body('TCK-B'), { webhookId: 'b' })
  expect(waiting.statusCode).toBe(202)
  expect(waiting.json()).toMatchObject({ ok: true, queued: true })
  const team = (
    db.sqlite.prepare("SELECT id FROM rooms WHERE role = 'team'").get() as { id: string }
  ).id
  const queue = async () =>
    (await app.inject({ method: 'GET', url: `/api/rooms/${team}/queue`, headers })).json() as {
      items: { id: string; title: string; source: { ref: string } }[]
    }
  expect((await queue()).items.map((item) => item.source.ref)).toEqual(['TCK-B'])
  // Stop job ends the running one; the waiting call starts with its own job and the lead's turn.
  const ended = await app.inject({
    method: 'POST',
    url: `/api/jobs/${first.id}/end`,
    headers: { ...headers, 'idempotency-key': 'end-a' },
    payload: {},
  })
  expect(ended.statusCode, ended.body).toBe(200)
  expect(ended.json().state).toBe('closed')
  await ingest.flushListeners()
  await ingest.drain()
  expect((await queue()).items).toEqual([])
  expect(jobs().map((job) => JSON.parse(job.source).ref)).toEqual(['TCK-A', 'TCK-B'])
  const turn = db.sqlite
    .prepare('SELECT agent_id FROM message_runs WHERE job_id = ?')
    .get(jobs()[1]!.id) as { agent_id: string }
  expect(turn.agent_id).toBe('lead')
  // Skip: the waiting call is dropped; a retry of it is answered and starts nothing.
  const third = await call(trigger.id, secret, body('TCK-C'), { webhookId: 'c' })
  expect(third.statusCode).toBe(202)
  const skipped = await app.inject({
    method: 'DELETE',
    url: `/api/rooms/${team}/queue/${third.json().queueId}`,
    headers: { ...headers, 'idempotency-key': 'skip-c' },
  })
  expect(skipped.statusCode).toBe(204)
  expect((await queue()).items).toEqual([])
  const retried = await call(trigger.id, secret, body('TCK-C'), { webhookId: 'c' })
  expect(retried.statusCode).toBe(200)
  expect(retried.json().jobId).toBeNull()
  expect(jobs()).toHaveLength(2)
})

test('3.28.0 review: a call left waiting when its job ended while Score was down starts when Score starts', async () => {
  const { trigger, secret } = await create()
  const body = (id: string) => JSON.stringify({ ticket: { ...ticket.ticket, id } })
  expect((await call(trigger.id, secret, body('TCK-A'), { webhookId: 'a' })).statusCode).toBe(200)
  expect((await call(trigger.id, secret, body('TCK-B'), { webhookId: 'b' })).statusCode).toBe(202)
  // Score stops; the job ends meanwhile (no event reaches a running server).
  await app.close()
  db.sqlite.prepare("UPDATE jobs SET state = 'closed' WHERE id = ?").run(jobs()[0]!.id)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: home }),
    logger: false,
    db,
    ingest,
    port,
    clock: () => now,
  })
  await app.ready()
  await ingest.flushListeners()
  await ingest.drain()
  expect(jobs().map((job) => JSON.parse(job.source).ref)).toEqual(['TCK-A', 'TCK-B'])
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM room_queue').get()).toEqual({ n: 0 })
})
