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

// 3.3.0 Bot Screen routes over the fake adapter (decision 135).

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-bot-screen-routes-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  port = new FakePort(1, { db, scheduler }, false)
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
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const get = (url: string, extra: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { ...headers, ...extra } })

test('a running screen gives its status and a PNG frame with an ETag', async () => {
  const status = await get('/api/agents/builder/bot-screen')
  expect(status.statusCode).toBe(200)
  expect(status.headers['cache-control']).toBe('no-store')
  expect(status.json()).toMatchObject({ state: 'running', width: 960, height: 600 })
  const frame = await get('/api/agents/builder/bot-screen/frame')
  expect(frame.statusCode).toBe(200)
  expect(frame.headers['content-type']).toBe('image/png')
  expect(frame.rawPayload.subarray(1, 4).toString('latin1')).toBe('PNG')
  const etag = frame.headers.etag as string
  expect(
    (await get('/api/agents/builder/bot-screen/frame', { 'if-none-match': etag })).statusCode,
  ).toBe(304)
  scheduler.advance(1000)
  const next = await get('/api/agents/builder/bot-screen/frame', { 'if-none-match': etag })
  expect(next.statusCode).toBe(200)
  expect(next.headers.etag).not.toBe(etag)
})

test('a screen that is off answers 409 with its state; unknown agents 404', async () => {
  expect((await get('/api/agents/reviewer/bot-screen')).json()).toEqual({ state: 'off' })
  const frame = await get('/api/agents/reviewer/bot-screen/frame')
  expect(frame.statusCode).toBe(409)
  expect(frame.json().error).toMatchObject({ code: 'conflict', details: { state: 'off' } })
  expect((await get('/api/agents/nobody/bot-screen')).statusCode).toBe(404)
})
