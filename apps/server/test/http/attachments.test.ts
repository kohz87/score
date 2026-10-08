import { RoomSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { multipart, png } from '../media-fixtures.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-attach-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  port = new FakePort(1, { db, scheduler }, false, (req) => ({
    text: req.agentId === 'builder' ? 'Over to @reviewer.' : 'Done.',
    tools: [],
  }))
  await port.start(ingest)
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
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function upload(seed: number): Promise<string> {
  const { body, contentType } = multipart([
    { name: 'file', filename: 'a.png', data: png(64, seed) },
  ])
  const res = await app.inject({
    method: 'POST',
    url: '/api/media',
    headers: { ...headers, 'content-type': contentType },
    payload: body,
  })
  return res.json().mediaId ?? res.json().id
}

test('only the person-authored turn carries the message images; hand-offs carry none', async () => {
  const run = vi.spyOn(port, 'startRun')
  const room = RoomSchema.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers,
        payload: { name: 'attach', leadAgentId: 'lead' },
      })
    ).json(),
  )
  const a = await upload(1)
  const b = await upload(2)
  const sent = await app.inject({
    method: 'POST',
    url: `/api/rooms/${room.id}/messages`,
    headers,
    payload: { text: '@builder look', attachments: [{ mediaId: a }, { mediaId: b }] },
  })
  expect(sent.statusCode).toBe(200)
  await vi.waitFor(() => expect(run.mock.calls.length).toBeGreaterThanOrEqual(1))
  expect(run.mock.calls[0]![0]).toMatchObject({ agentId: 'builder', images: [a, b] })
  await scheduler.advance(5000)
  await vi.waitFor(() => expect(run.mock.calls.length).toBeGreaterThanOrEqual(2), {
    timeout: 3000,
  })
  const handoff = run.mock.calls.find(([req]) => req.agentId === 'reviewer')
  expect(handoff).toBeDefined()
  expect(handoff![0].images).toBeUndefined()
})
