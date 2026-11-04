import { RoomSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

// 3.28.0 (decision 164): one job per group chat — the rule, Stop job, and what frees a chat.

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let roomId: string
/** What each agent was sent, as Hermes would receive it (after the capability was filled in). */
let wire: { agentId: string; input: string }[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-onejob-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  wire = []
  port = new FakePort(1, { db, scheduler }, false, (req) => {
    wire.push({ agentId: req.agentId, input: req.input })
    return { text: 'Working on it.', tools: [] }
  })
  await port.start(ingest)
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
  const created = await post('/api/rooms', { name: 'team-like', leadAgentId: 'lead' })
  roomId = RoomSchema.parse(created.json()).id
  db.sqlite.prepare("UPDATE rooms SET routing = 'exchanges' WHERE id = ?").run(roomId)
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload })
const send = (payload: object) => post(`/api/rooms/${roomId}/messages`, payload)
async function advance(ms: number) {
  await scheduler.advance(ms)
  await ingest.flushListeners()
  await ingest.drain()
}

const jobsOf = async () =>
  (await app.inject({ method: 'GET', url: `/api/rooms/${roomId}/jobs`, headers })).json() as {
    items: { id: string; state: string; isDefault: boolean }[]
  }

test('a group chat holds one running job: a second is refused with the running one named', async () => {
  const first = await post(`/api/rooms/${roomId}/jobs`, { title: 'Ship the feed' })
  expect(first.statusCode).toBe(201)
  const second = await post(`/api/rooms/${roomId}/jobs`, { title: 'Another' })
  expect(second.statusCode).toBe(409)
  expect(second.json().error).toMatchObject({
    code: 'job_running',
    details: { jobId: first.json().id, title: 'Ship the feed' },
  })
  // A finished job doesn't count.
  db.sqlite.prepare("UPDATE jobs SET state = 'done' WHERE id = ?").run(first.json().id)
  expect((await post(`/api/rooms/${roomId}/jobs`, { title: 'Next' })).statusCode).toBe(201)
})

test('Stop job stops the work and closes the job, even while it is working; then the chat is free', async () => {
  const job = (await post(`/api/rooms/${roomId}/jobs`, { title: 'Ship the feed' })).json() as {
    id: string
  }
  expect((await send({ text: '@builder Build the feed', jobId: job.id })).statusCode).toBe(200)
  await advance(10)
  // Close alone waits for the work; Stop job doesn't.
  expect((await post(`/api/jobs/${job.id}/close`, {})).statusCode).toBe(409)
  const ended = await post(`/api/jobs/${job.id}/end`, {})
  expect(ended.statusCode, ended.body).toBe(200)
  expect(ended.json().state).toBe('closed')
  expect(
    db.sqlite
      .prepare("SELECT count(*) AS n FROM message_runs WHERE job_id = ? AND state = 'pending'")
      .get(job.id),
  ).toEqual({ n: 0 })
  // Idempotent, and a late turn settling doesn't reopen it.
  expect((await post(`/api/jobs/${job.id}/end`, {})).json().state).toBe('closed')
  await advance(60_000)
  expect((await jobsOf()).items.map((item) => item.id)).not.toContain(job.id)
  const next = await post(`/api/rooms/${roomId}/jobs`, { title: 'Next' })
  expect(next.statusCode).toBe(201)
  // The ended job can't come back while the next one runs.
  const reopened = await post(`/api/jobs/${job.id}/reopen`, {})
  expect(reopened.statusCode).toBe(409)
  expect(reopened.json().error.code).toBe('job_running')
})

test('the room’s own thread has no Stop job, and deleting the running job frees the chat', async () => {
  const own = (await jobsOf()).items.find((item) => item.isDefault)!
  expect((await post(`/api/jobs/${own.id}/end`, {})).statusCode).toBe(409)
  const job = (await post(`/api/rooms/${roomId}/jobs`, { title: 'Ship the feed' })).json() as {
    id: string
  }
  const removed = await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}`, headers })
  expect(removed.statusCode).toBe(204)
  expect((await post(`/api/rooms/${roomId}/jobs`, { title: 'Next' })).statusCode).toBe(201)
  // Undoing the delete would make two: refused while the next one runs.
  const restored = await post(`/api/jobs/${job.id}/restore`, {})
  expect(restored.statusCode).toBe(409)
})

test('Stop job still stops a closed job’s leftover work (a run closes its job first), and a deleted job is 404', async () => {
  const job = (await post(`/api/rooms/${roomId}/jobs`, { title: 'Run job' })).json() as {
    id: string
  }
  expect((await send({ text: '@builder Build the feed', jobId: job.id })).statusCode).toBe(200)
  // As a run's end does: the job is closed with its turn still queued.
  db.sqlite.prepare("UPDATE jobs SET state = 'closed' WHERE id = ?").run(job.id)
  db.sqlite
    .prepare("UPDATE message_runs SET state = 'pending' WHERE job_id = ? AND state = 'active'")
    .run(job.id)
  expect((await post(`/api/jobs/${job.id}/end`, {})).statusCode).toBe(200)
  expect(
    db.sqlite
      .prepare(
        "SELECT count(*) AS n FROM message_runs WHERE job_id = ? AND state IN ('pending', 'active')",
      )
      .get(job.id),
  ).toEqual({ n: 0 })
  const gone = (await post(`/api/rooms/${roomId}/jobs`, { title: 'Gone' })).json() as { id: string }
  expect(
    (await app.inject({ method: 'DELETE', url: `/api/jobs/${gone.id}`, headers })).statusCode,
  ).toBe(204)
  expect((await post(`/api/jobs/${gone.id}/end`, {})).statusCode).toBe(404)
})
