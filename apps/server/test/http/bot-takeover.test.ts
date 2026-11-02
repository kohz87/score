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

// 3.17.0: taking over a bot's desktop, over the fake adapter (docs/briefs/3.17.0-take-over.md).

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-take-over-routes-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  port = new FakePort(1, { db, scheduler }, false)
  await port.start(ingest)
  scheduler.clearTimeout(0)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: dir }),
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
  // The app projects the roster at startup; the routes read that projection.
  expect((await app.inject({ method: 'GET', url: '/api/agents', headers })).statusCode).toBe(200)
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

let key = 0
const post = (url: string, payload: object, as = headers) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...as, 'idempotency-key': `k-${++key}` },
    payload,
  })
const base = '/api/agents/builder/bot-screen'
async function secondSession() {
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  return {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
}
async function setPassword() {
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/session/security/password',
        headers,
        payload: { password: 'correct horse battery' },
      })
    ).statusCode,
  ).toBeLessThan(300)
  // Setting the first password unlocks this session; lock it so the password itself is needed.
  await post('/api/session/security/lock', {})
}

test('taking over needs the password (or an unlocked session); only the taker sees and drives the screen', async () => {
  await setPassword()
  expect((await post(`${base}/take-over`, {})).statusCode).toBe(403)
  expect((await post(`${base}/take-over`, { password: 'wrong' })).statusCode).toBe(403)
  const taken = await post(`${base}/take-over`, { password: 'correct horse battery' })
  expect(taken.statusCode, taken.body).toBe(200)
  const { takeoverId } = taken.json() as { takeoverId: string }
  const mine = await app.inject({ method: 'GET', url: base, headers })
  expect(mine.json()).toMatchObject({ state: 'running', control: { takeoverId } })
  const other = await secondSession()
  expect((await app.inject({ method: 'GET', url: base, headers: other })).json()).toEqual({
    state: 'human',
  })
  expect(
    (await app.inject({ method: 'GET', url: `${base}/frame`, headers: other })).statusCode,
  ).toBe(409)
  const events = [
    { k: 'key', keysym: 0x61, down: true },
    { k: 'pointer', x: 10, y: 10, buttons: 1 },
  ]
  expect((await post(`${base}/input`, { takeoverId, events })).statusCode).toBe(204)
  expect(port.botTakeovers.inputs.get('builder')).toBe(2)
  // Another session can't type into it, beat for it or hand it back.
  expect((await post(`${base}/input`, { takeoverId, events }, other)).statusCode).toBe(409)
  expect((await post(`${base}/heartbeat`, { takeoverId }, other)).statusCode).toBe(409)
  await post(`${base}/hand-back`, { takeoverId }, other)
  expect((await app.inject({ method: 'GET', url: base, headers })).json()).toMatchObject({
    control: { takeoverId },
  })
  // A second take while held is busy, even with the right password.
  expect(
    (await post(`${base}/take-over`, { password: 'correct horse battery' }, other)).statusCode,
  ).toBe(409)
  expect((await post(`${base}/heartbeat`, { takeoverId })).statusCode).toBe(204)
  expect((await post(`${base}/hand-back`, { takeoverId })).statusCode).toBe(204)
  expect((await post(`${base}/hand-back`, { takeoverId })).statusCode).toBe(204)
  expect((await post(`${base}/input`, { takeoverId, events })).statusCode).toBe(409)
  expect((await app.inject({ method: 'GET', url: base, headers: other })).json()).toMatchObject({
    state: 'running',
  })
})

test('an unlocked session takes over without the password; a screen that is off can’t be taken', async () => {
  await setPassword()
  expect(
    (await post('/api/session/security/unlock', { password: 'correct horse battery' })).statusCode,
  ).toBe(200)
  expect((await post(`${base}/take-over`, {})).statusCode).toBe(200)
  expect(
    (await post('/api/agents/lead/bot-screen/take-over', { password: 'correct horse battery' }))
      .statusCode,
  ).toBe(409)
})

test('input is validated: unknown kinds, too many events and coordinates out of range are refused', async () => {
  await setPassword()
  const { takeoverId } = (
    await post(`${base}/take-over`, { password: 'correct horse battery' })
  ).json() as { takeoverId: string }
  for (const events of [
    [{ k: 'clipboard', text: 'x' }],
    Array.from({ length: 201 }, () => ({ k: 'key', keysym: 0x61, down: true })),
    [{ k: 'pointer', x: -1, y: 0, buttons: 0 }],
    [],
  ])
    expect((await post(`${base}/input`, { takeoverId, events })).statusCode).toBe(400)
  expect(
    (
      await app.inject({
        method: 'POST',
        url: `${base}/input`,
        headers: { 'x-score-client': 'web' },
        payload: { takeoverId, events: [] },
      })
    ).statusCode,
  ).toBe(401)
})

test('a passkey proved moments ago lets one takeover through without the password, once', async () => {
  await setPassword()
  app.pairing.markFresh(headers.cookie)
  const taken = await post(`${base}/take-over`, {})
  expect(taken.statusCode, taken.body).toBe(200)
  const { takeoverId } = taken.json() as { takeoverId: string }
  await post(`${base}/hand-back`, { takeoverId })
  // Consumed: the next take needs proof again.
  expect((await post(`${base}/take-over`, {})).statusCode).toBe(403)
})
