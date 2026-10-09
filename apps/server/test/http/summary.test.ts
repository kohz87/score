import { RoomSchema, StreamEventSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { attachRunMessage, completeRunMessage } from '../../src/domain/message-runs.ts'
import { storeMessage } from '../../src/domain/rooms.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: HermesPort
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-summary-http-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  const scheduler = new FakeScheduler()
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
  vi.spyOn(port, 'startRun').mockResolvedValue({ runId: 'summary-test-run' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const call = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) })
const at = (n: number) => new Date(Date.UTC(2026, 9, 9, 9, 0, n)).toISOString()

async function room() {
  const response = await call('POST', '/api/rooms', {
    name: 'team',
    leadAgentId: 'lead',
    members: ['lead'],
  })
  return RoomSchema.parse(response.json())
}
function say(roomId: string, n: number, text: string) {
  storeMessage(
    db.sqlite,
    {
      id: `m${n}`,
      roomId,
      author: { kind: 'you' },
      to: [],
      parts: [{ kind: 'text', text }],
      createdAt: at(n),
      streaming: false,
      refs: [],
    },
    at(n),
  )
}

test('the setting is per room, off by default, validated and carried by the room', async () => {
  const created = await room()
  expect(created.autoSummary).toEqual({ enabled: false, thresholdTokens: 12000 })
  const bad = await call('PATCH', `/api/rooms/${created.id}`, {
    autoSummary: { enabled: true, thresholdTokens: 10 },
  })
  expect(bad.statusCode).toBe(400)
  const patched = await call('PATCH', `/api/rooms/${created.id}`, {
    autoSummary: { enabled: true, thresholdTokens: 5000 },
  })
  expect(RoomSchema.parse(patched.json()).autoSummary).toEqual({
    enabled: true,
    thresholdTokens: 5000,
  })
})

test('regenerate, edit and delete the summary', async () => {
  const created = await room()
  const empty = await call('POST', `/api/rooms/${created.id}/summary`, {})
  expect(empty.statusCode).toBe(409)
  say(created.id, 1, 'hello team')
  const queued = await call('POST', `/api/rooms/${created.id}/summary`, {})
  expect(queued.statusCode).toBe(202)
  expect(await call('POST', `/api/rooms/${created.id}/summary`, {})).toMatchObject({
    statusCode: 409,
  })
  // The run is admitted through the lead like any reply, and writes the summary part when it completes.
  expect(vi.mocked(port.startRun).mock.calls[0]?.[0]).toMatchObject({ agentId: 'lead' })
  const turn = db.sqlite
    .prepare("SELECT turn_id FROM message_runs WHERE purpose = 'summary'")
    .get() as { turn_id: string }
  await ingest.submit({
    source: 'test',
    identity: 'finish',
    apply: ({ sqlite, now }) => {
      sqlite
        .prepare(
          "INSERT OR IGNORE INTO runs (id, profile, origin, status, started_at, updated_at) VALUES ('rs', 'lead', 'score', 'completed', ?, ?)",
        )
        .run(now, now)
      return [
        ...attachRunMessage(sqlite, turn.turn_id, 'rs', now),
        ...completeRunMessage(sqlite, 'rs', now, { output: 'The team said hello.' }),
      ]
    },
  })
  const listed = (
    await app.inject({ method: 'GET', url: `/api/rooms/${created.id}/messages` })
  ).json() as {
    items: { parts: { kind: string; text?: string }[] }[]
  }
  expect(listed.items.some((item) => item.parts[0]?.kind === 'summary')).toBe(true)

  const edited = await call('PATCH', `/api/rooms/${created.id}/summary`, {
    text: 'Edited <b>summary</b>',
  })
  expect(edited.statusCode).toBe(200)
  expect(edited.json()).toMatchObject({
    parts: [{ kind: 'summary', coversUntil: 'm1', text: 'Edited summary', edited: true }],
  })
  const updated = db.sqlite
    .prepare(
      "SELECT type, data FROM events WHERE type = 'message.updated' ORDER BY seq DESC LIMIT 1",
    )
    .get() as { type: string; data: string }
  expect(
    StreamEventSchema.parse({
      seq: 1,
      ts: at(0),
      type: updated.type,
      data: JSON.parse(updated.data),
    }),
  ).toBeDefined()

  expect((await call('DELETE', `/api/rooms/${created.id}/summary`)).statusCode).toBe(204)
  expect((await call('DELETE', `/api/rooms/${created.id}/summary`)).statusCode).toBe(404)
  expect((await call('PATCH', `/api/rooms/${created.id}/summary`, { text: 'x' })).statusCode).toBe(
    404,
  )
})
