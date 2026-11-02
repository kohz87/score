import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HermesUpdateStatusSchema } from '@score/contract'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let app: ReturnType<typeof buildApp>
let cookie = ''

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-hermes-update-'))
  db = openDatabase(path.join(dir, 'score.db'))
  migrate(db, new URL('../../migrations/', import.meta.url).pathname)
  ingest = createIngest(db)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: dir }),
    logger: false,
    port: new FakePort(1, {}, false),
    db,
    ingest,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  cookie = paired.headers['set-cookie']!.toString().split(';')[0]!
})
afterEach(async () => {
  await app.close()
  await ingest.close()
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const headers = () => ({ 'x-score-client': 'web', cookie })
let key = 0
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { ...headers(), 'idempotency-key': `k-${++key}` },
    ...(payload ? { payload } : {}),
  })

test('3.15.0: status and check need a paired person; starting needs the security password', async () => {
  expect((await app.inject({ url: '/api/system/hermes-update' })).statusCode).toBe(401)
  const status = HermesUpdateStatusSchema.parse(
    (await call('GET', '/api/system/hermes-update')).json(),
  )
  expect(status).toMatchObject({ available: true, job: null, lastCheck: null })
  expect(status.version).toMatch(/^v0\.22\.5\+3257/)

  const checked = await call('POST', '/api/system/hermes-update/check', { channel: 'main' })
  expect(checked.statusCode, checked.body).toBe(200)
  expect(checked.json()).toMatchObject({
    channel: 'main',
    available: true,
    behind: 12,
    restarts: ['gateway [default]'],
  })
  expect(
    (await call('POST', '/api/system/hermes-update/check', { channel: 'nightly' })).statusCode,
  ).toBe(400)

  const start = (password: string) =>
    call('POST', '/api/system/hermes-update/start', {
      channel: 'main',
      testAgentId: 'builder',
      password,
    })
  expect((await start('anything at all')).json().error.code).toBe('password_not_set')
  await call('PUT', '/api/session/security/password', { password: 'correct horse battery' })
  expect((await start('wrong guess!!')).statusCode).toBe(403)
  const started = await start('correct horse battery')
  expect(started.statusCode, started.body).toBe(202)
  expect(started.json()).toMatchObject({
    state: 'running',
    channel: 'main',
    testAgentId: 'builder',
  })
  // One at a time.
  expect((await start('correct horse battery')).json().error.code).toBe('update_running')

  let job = started.json()
  for (let i = 0; i < 60 && job.state !== 'finished'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    job = (await call('GET', '/api/system/hermes-update')).json().job
  }
  // Fake mode reports one changed part: approvals can be turned on anyway.
  expect(job).toMatchObject({
    state: 'finished',
    outcome: 'differs',
    toVersion: 'v0.22.5+3269.g7a1b2c3',
    backup: 'hermes-backup-20261102-0947.zip',
    test: { agentId: 'builder', ok: true },
  })
}, 30_000)
