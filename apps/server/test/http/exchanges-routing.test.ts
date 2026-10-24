import { JobSchema, RoomSchema } from '@score/contract'
import { createHash } from 'node:crypto'
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

// PLAN 11.1b through the HTTP routes and the dispatcher, on the fake adapter: posting into an exchanges room, the
// per-turn capability on the wire, jobs.

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
  dir = mkdtempSync(join(tmpdir(), 'score-xroute-'))
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

test("a Hermes agent's turn gets a capability on the wire only; the database keeps the placeholder and a hash", async () => {
  expect((await send({ text: '@builder Build the feed' })).statusCode).toBe(200)
  await advance(10)
  const sent = wire.find((item) => item.agentId === 'builder')!.input
  const capability = /xtc_[A-Za-z0-9_-]{43}/.exec(sent)![0]
  expect(sent).toContain('score_review')
  const row = db.sqlite
    .prepare("SELECT admission_input, xtc_hash, state FROM message_runs WHERE agent_id = 'builder'")
    .get() as { admission_input: string; xtc_hash: string | null; state: string }
  expect(row.admission_input).toContain('{{SCORE_EXCHANGE_CAPABILITY}}')
  expect(row.admission_input).not.toContain(capability)
  if (row.state === 'active')
    expect(row.xtc_hash).toBe(createHash('sha256').update(capability).digest('hex'))
  await advance(60_000)
  expect(
    db.sqlite.prepare("SELECT xtc_hash, state FROM message_runs WHERE agent_id = 'builder'").get(),
  ).toEqual({ xtc_hash: null, state: 'completed' })
  // Nothing anywhere in Score's database holds the plaintext.
  const dump = JSON.stringify(
    db.sqlite
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .flatMap(({ name }) => db.sqlite.prepare(`SELECT * FROM "${String(name)}"`).all()),
  )
  expect(dump).not.toContain(capability)
})

test('the addressed agent becomes the holder; an unaddressed message during a live exchange starts nothing', async () => {
  await send({ text: '@builder Build the feed' })
  await advance(60_000)
  const job = JobSchema.parse(
    (await app.inject({ url: `/api/rooms/${roomId}/jobs`, headers })).json().items[0],
  )
  expect(job).toMatchObject({ isDefault: true, holderAgentId: 'builder', title: '#team-like' })
  db.sqlite
    .prepare(
      `INSERT INTO exchanges (id, job_id, kind, from_agent_id, to_agent_id, state, budget, opened_by_turn_id, created_at, updated_at)
       VALUES ('xch_1', ?, 'review', 'builder', 'reviewer', 'live', 8, 't', ?, ?)`,
    )
    .run(job.id, job.createdAt, job.createdAt)
  const turns = () =>
    (db.sqlite.prepare('SELECT count(*) AS n FROM message_runs').get() as { n: number }).n
  const before = turns()
  const stepIn = await send({ text: 'Keep the page size at 25.' })
  expect(stepIn.statusCode).toBe(200)
  expect(stepIn.json().routedTo).toEqual([])
  expect(turns()).toBe(before)
})

test('the team room without a lead refuses an unaddressed message', async () => {
  db.sqlite.prepare("UPDATE rooms SET role = 'team', lead_agent_id = NULL WHERE id = ?").run(roomId)
  const response = await send({ text: 'Who is on this?' })
  expect(response.statusCode).toBe(409)
  expect(response.json().error.code).toBe('no_lead')
})

test('jobs: create, list, post into one, and its exchanges', async () => {
  const created = await post(`/api/rooms/${roomId}/jobs`, { title: 'Release notes 2.4' })
  expect(created.statusCode).toBe(201)
  const job = JobSchema.parse(created.json())
  expect(job).toMatchObject({
    isDefault: false,
    state: 'open',
    exchangeBudget: 8,
    jobTurnLimit: 40,
  })
  const listed = (await app.inject({ url: `/api/rooms/${roomId}/jobs`, headers })).json()
  expect(listed.items.map((item: { title: string }) => item.title)).toEqual([
    '#team-like',
    'Release notes 2.4',
  ])
  const sent = await send({ text: '@lead Draft the notes', jobId: job.id })
  expect(sent.json().message.jobId).toBe(job.id)
  await advance(60_000)
  const reply = db.sqlite
    .prepare("SELECT job_id FROM messages WHERE author_kind = 'agent' AND room_id = ?")
    .get(roomId)
  expect(reply).toEqual({ job_id: job.id })
  expect(
    db.sqlite.prepare("SELECT session_id FROM job_sessions WHERE agent_id = 'lead'").get(),
  ).toEqual({ session_id: `score-${roomId}-${job.id}-lead` })
  const exchanges = await app.inject({ url: `/api/jobs/${job.id}/exchanges`, headers })
  expect(exchanges.json()).toMatchObject({ items: [] })
  expect((await app.inject({ url: '/api/jobs/job_nope/exchanges', headers })).statusCode).toBe(404)
})
