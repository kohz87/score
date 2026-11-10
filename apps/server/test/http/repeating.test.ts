import { MovedRepeatingJobSchema, RepeatingJobsResponseSchema, RoomSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { repeatingRunner } from '../../src/domain/repeating-runner.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

// Decision 183: Tasks › Repeating lists every agent's jobs; a job's results reach its chat once; moving keeps them.
let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let roomId: string
let keys = 0

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-repeating-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  port = new FakePort(1, { db, scheduler }, false, () => ({ text: 'Done.', tools: [] }))
  await port.start(ingest)
  scheduler.clearTimeout(0)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    clock,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
  roomId = RoomSchema.parse(
    (
      await send('POST', '/api/team-rooms', {
        name: 'reports',
        members: ['lead', 'builder'],
        leadAgentId: 'lead',
      })
    ).json(),
  ).id
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function send(method: 'POST' | 'PATCH', url: string, payload: object) {
  return app.inject({
    method,
    url,
    headers: { ...headers, 'idempotency-key': `k${++keys}` },
    payload,
  })
}
const list = async () =>
  RepeatingJobsResponseSchema.parse(
    (await app.inject({ method: 'GET', url: '/api/routines', headers })).json(),
  )
const messages = () =>
  db.sqlite
    .prepare(
      "SELECT author_agent_id, parts FROM messages WHERE room_id = ? AND author_kind = 'agent'",
    )
    .all(roomId) as { author_agent_id: string; parts: string }[]
const runner = () =>
  repeatingRunner({
    orchestrator: { createWorkflowRun: () => Promise.reject(new Error('no recipes here')) },
    db,
    ingest,
    port,
    clock: () => scheduler.now(),
  })

test('the list spans agents and says where results go; a run’s result is posted into that chat once', async () => {
  const made = await send('POST', '/api/agents/builder/routines', {
    title: 'Morning summary',
    schedule: '0 8 * * *',
    prompt: 'Sum up yesterday.',
    timezone: 'Asia/Singapore',
    deliverTo: roomId,
  })
  expect(made.statusCode).toBe(200)
  const job = made.json()
  expect(job).toMatchObject({ agentId: 'builder', deliverTo: { roomId, roomName: 'reports' } })
  await send('POST', '/api/agents/lead/routines', {
    title: 'Weekly',
    schedule: '0 17 * * 5',
    prompt: 'Report.',
  })
  const listed = await list()
  expect(listed.items.map((one) => [one.agentId, one.title])).toEqual(
    expect.arrayContaining([
      ['builder', 'Morning summary'],
      ['lead', 'Weekly'],
    ]),
  )
  expect(listed.unreadable).toEqual([])

  await scheduler.advance(1000)
  expect((await send('POST', `/api/routines/${job.id}/run`, {})).statusCode).toBe(200)
  await runner().tick()
  await runner().tick()
  const posted = messages()
  expect(posted).toHaveLength(1)
  expect(posted[0]!.author_agent_id).toBe('builder')
  expect(posted[0]!.parts).toContain('**Morning summary** · repeating job')
})

test('moving a job to another agent keeps where its results go; a pin and a title change go through', async () => {
  const job = (
    await send('POST', '/api/agents/builder/routines', {
      title: 'Dependency check',
      schedule: 'every 2h',
      prompt: 'Look for outdated packages.',
      deliverTo: roomId,
    })
  ).json()
  const moved = MovedRepeatingJobSchema.parse(
    (await send('POST', `/api/routines/${job.id}/move`, { agentId: 'lead' })).json(),
  )
  expect(moved.leftBehind).toBeNull()
  expect(moved.job).toMatchObject({
    agentId: 'lead',
    title: 'Dependency check',
    deliverTo: { roomId },
  })
  expect((await list()).items.some((one) => one.id === job.id)).toBe(false)
  const patched = (
    await send('PATCH', `/api/routines/${moved.job.id}`, {
      title: 'Package check',
      model: { model: 'local-gpt-mini', provider: 'local' },
      deliverTo: null,
    })
  ).json()
  expect(patched).toMatchObject({
    title: 'Package check',
    model: 'local-gpt-mini',
    deliverTo: null,
  })
})

test('a result saved before results were sent to the chat is not posted', async () => {
  const job = (
    await send('POST', '/api/agents/builder/routines', {
      title: 'Old',
      schedule: 'every 1h',
      prompt: 'x',
    })
  ).json()
  await send('POST', `/api/routines/${job.id}/run`, {})
  await scheduler.advance(1000)
  await send('PATCH', `/api/routines/${job.id}`, { deliverTo: roomId })
  await runner().tick()
  expect(messages()).toEqual([])
})

test('switching the results to another chat never sends it results saved before the switch', async () => {
  const other = RoomSchema.parse(
    (
      await send('POST', '/api/team-rooms', {
        name: 'other',
        members: ['lead', 'builder'],
        leadAgentId: 'lead',
      })
    ).json(),
  ).id
  const job = (
    await send('POST', '/api/agents/builder/routines', {
      title: 'Digest',
      schedule: 'every 1h',
      prompt: 'x',
      deliverTo: roomId,
    })
  ).json()
  await scheduler.advance(1000)
  await send('POST', `/api/routines/${job.id}/run`, {})
  await scheduler.advance(1000)
  await send('PATCH', `/api/routines/${job.id}`, { deliverTo: other })
  await runner().tick()
  const inOther = db.sqlite
    .prepare("SELECT 1 FROM messages WHERE room_id = ? AND author_kind = 'agent'")
    .all(other)
  expect(inOther).toEqual([])
})

test('a chat that doesn’t exist is refused before Hermes changes anything', async () => {
  const before = (await list()).items.length
  const refused = await send('POST', '/api/agents/builder/routines', {
    title: 'Nowhere',
    schedule: 'every 1h',
    prompt: 'x',
    deliverTo: 'no-such-chat',
  })
  expect(refused.statusCode).toBe(400)
  expect((await list()).items).toHaveLength(before)
})
