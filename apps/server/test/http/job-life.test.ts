import { JobSchema, JobsResponseSchema, StreamEventSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { openExchange } from '../../src/domain/exchanges/store.ts'
import { insertRoom } from '../../src/domain/rooms.ts'
import { ensureTeamRoom, teamRoomId } from '../../src/domain/team-room.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

// Decision 121 (D6): a named job can be renamed, closed and reopened, deleted and restored; the room's own thread can't.
let dir: string
let db: ScoreDb
let ingest: Ingest
let port: HermesPort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let roomId: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-job-life-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  port = createHermesPort(loadConfig({ SCORE_MODE: 'fake', SCORE_FAKE_LOOP: 'false' }), {
    db,
    scheduler,
  })
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
  db.tx((sqlite) =>
    ensureTeamRoom(sqlite, ['lead', 'builder'], new Date(scheduler.now()).toISOString()),
  )
  roomId = db.read((sqlite) => teamRoomId(sqlite))!
  vi.spyOn(port, 'startRun').mockResolvedValue({ runId: 'job-life-run' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
const jobs = async () =>
  JobsResponseSchema.parse((await app.inject({ url: `/api/rooms/${roomId}/jobs` })).json()).items
const events = () =>
  db.sqlite
    .prepare('SELECT * FROM events ORDER BY seq')
    .all()
    .map((row) =>
      StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) as unknown }),
    )

async function makeJob(title: string) {
  const made = await send('POST', `/api/rooms/${roomId}/jobs`, { title })
  expect(made.statusCode).toBe(201)
  return JobSchema.parse(made.json())
}
const post = (jobId: string, text: string) =>
  send('POST', `/api/rooms/${roomId}/messages`, { text, jobId, to: ['lead'] })
const settle = () =>
  db.sqlite
    .prepare("UPDATE message_runs SET state = 'completed' WHERE state IN ('pending', 'active')")
    .run()

test('rename changes a named job’s title and announces it; the room’s own thread refuses', async () => {
  const job = await makeJob('Release notes')
  const renamed = await send('PATCH', `/api/jobs/${job.id}`, { title: 'Release notes 2.5' })
  expect(renamed.statusCode).toBe(200)
  expect(JobSchema.parse(renamed.json()).title).toBe('Release notes 2.5')
  expect(
    events().some((e) => e.type === 'job.upserted' && e.data.title === 'Release notes 2.5'),
  ).toBe(true)
  const fallback = (await jobs()).find((item) => item.isDefault)!
  expect((await send('PATCH', `/api/jobs/${fallback.id}`, { title: 'X' })).statusCode).toBe(409)
  expect((await send('PATCH', `/api/jobs/${job.id}`, { title: '  ' })).statusCode).toBe(400)
})

test('close waits for running work, leaves the list, refuses messages, and reopen brings it back', async () => {
  const job = await makeJob('Activity feed')
  expect((await post(job.id, 'Start on it')).statusCode).toBe(200)
  const refused = await send('POST', `/api/jobs/${job.id}/close`)
  expect(refused.statusCode).toBe(409)
  expect(refused.json().error.message).toMatch(/Stop it first/)
  settle()
  const closed = await send('POST', `/api/jobs/${job.id}/close`)
  expect(JobSchema.parse(closed.json()).state).toBe('closed')
  expect((await jobs()).map((item) => item.id)).not.toContain(job.id)
  expect((await post(job.id, 'One more thing')).statusCode).toBe(409)
  const reopened = await send('POST', `/api/jobs/${job.id}/reopen`)
  expect(JobSchema.parse(reopened.json()).state).toBe('open')
  expect((await jobs()).map((item) => item.id)).toContain(job.id)
})

test('delete hides the job and its messages, keeps earlier deletions, and restore undoes exactly that', async () => {
  const job = await makeJob('Queue research')
  const first = (await post(job.id, 'First note')).json().message.id as string
  const second = (await post(job.id, 'Second note')).json().message.id as string
  settle()
  expect((await send('DELETE', `/api/rooms/${roomId}/messages/${first}`)).statusCode).toBe(204)
  scheduler.advance(1000)
  expect((await send('DELETE', `/api/jobs/${job.id}`)).statusCode).toBe(204)
  expect(events().at(-1)).toMatchObject({ type: 'job.deleted', data: { id: job.id, roomId } })
  expect((await jobs()).map((item) => item.id)).not.toContain(job.id)
  const visible = () =>
    db.sqlite
      .prepare('SELECT id FROM messages WHERE job_id = ? AND deleted_at IS NULL ORDER BY id')
      .all(job.id)
      .map((row) => (row as { id: string }).id)
  expect(visible()).toEqual([])
  expect((await post(job.id, 'Too late')).statusCode).toBe(404)
  // Deleting twice is fine; restoring brings back only what the job's delete hid.
  expect((await send('DELETE', `/api/jobs/${job.id}`)).statusCode).toBe(204)
  const restored = await send('POST', `/api/jobs/${job.id}/restore`)
  expect(JobSchema.parse(restored.json()).id).toBe(job.id)
  expect(visible()).toContain(second)
  expect(visible()).not.toContain(first)
  expect((await jobs()).map((item) => item.id)).toContain(job.id)
})

test('the room’s own thread can’t be closed or deleted', async () => {
  const fallback = (await jobs()).find((item) => item.isDefault)!
  expect((await send('POST', `/api/jobs/${fallback.id}/close`)).statusCode).toBe(409)
  expect((await send('DELETE', `/api/jobs/${fallback.id}`)).statusCode).toBe(409)
})

test('a room already named after the agent doesn’t block the agent’s first one-to-one', async () => {
  const agentName = (await port.listAgents()).find((agent) => agent.id === 'builder')!.name
  // An older room already has the agent's name (room names are unique), and builder has no direct room yet.
  db.tx((sqlite) =>
    insertRoom(
      sqlite,
      { id: 'room-named', name: agentName, kind: 'room', leadAgentId: 'lead', members: ['lead'] },
      new Date(scheduler.now()).toISOString(),
    ),
  )
  const chat = await send('POST', '/api/agents/builder/chats', { title: 'First chat' })
  expect(chat.statusCode).toBe(201)
  const direct = db.sqlite
    .prepare("SELECT name FROM rooms WHERE kind = 'direct' AND lead_agent_id = 'builder'")
    .get() as { name: string }
  expect(direct.name).toBe(`${agentName} (one to one)`)
})

test('a paused exchange keeps the job open: close waits for Stop, and a closed job takes no decision', async () => {
  const job = await makeJob('Review the feed')
  const exchangeId = db.tx((sqlite) => {
    const id = openExchange(
      sqlite,
      {
        jobId: job.id,
        kind: 'review',
        parentId: null,
        from: 'builder',
        to: 'lead',
        turnId: 'turn-x',
      },
      new Date(scheduler.now()).toISOString(),
    )
    sqlite.prepare("UPDATE exchanges SET state = 'paused_budget' WHERE id = ?").run(id)
    return id
  })
  // No run row, but the paused exchange holds a turn: the job is still working.
  expect((await send('POST', `/api/jobs/${job.id}/close`)).statusCode).toBe(409)
  expect((await send('DELETE', `/api/jobs/${job.id}`)).statusCode).toBe(409)
  expect((await send('POST', `/api/jobs/${job.id}/stop`)).statusCode).toBe(200)
  expect(JobSchema.parse((await send('POST', `/api/jobs/${job.id}/close`)).json()).state).toBe(
    'closed',
  )
  // Stop again, or a decision on the stopped exchange, can't reopen it behind the person's back.
  await send('POST', `/api/jobs/${job.id}/stop`)
  const row = db.sqlite.prepare('SELECT state FROM jobs WHERE id = ?').get(job.id) as {
    state: string
  }
  expect(row.state).toBe('closed')
  const decided = await send('POST', `/api/exchanges/${exchangeId}/decision`, {
    option: 'more_turns',
    turns: 4,
  })
  expect([404, 409]).toContain(decided.statusCode)
})

test('a deleted job’s results, workbench and exchanges answer 404', async () => {
  const job = await makeJob('Gone soon')
  expect((await send('DELETE', `/api/jobs/${job.id}`)).statusCode).toBe(204)
  for (const part of ['results', 'workbench', 'exchanges'])
    expect((await app.inject({ url: `/api/jobs/${job.id}/${part}` })).statusCode, part).toBe(404)
})

test('closed jobs come back in the list when asked for, so the job menu can find and reopen them', async () => {
  const job = await makeJob('Old idea')
  await send('POST', `/api/jobs/${job.id}/close`)
  const all = JobsResponseSchema.parse(
    (await app.inject({ url: `/api/rooms/${roomId}/jobs?closed=include` })).json(),
  ).items
  expect(all.find((item) => item.id === job.id)?.state).toBe('closed')
  expect((await jobs()).map((item) => item.id)).not.toContain(job.id)
})
