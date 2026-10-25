import { JobSchema, JobsResponseSchema, StreamEventSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
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
