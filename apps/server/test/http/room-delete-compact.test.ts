import {
  RoomDeletePlanSchema,
  RoomSchema,
  SessionContextSnapshotSchema,
  StreamEventSchema,
} from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { compactingSessions, rewindingRooms } from '../../src/domain/room-rewinding.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import type { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: HermesPort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-room-delete-'))
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
  vi.spyOn(port, 'startRun').mockResolvedValue({ runId: 'room-delete-run' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  rewindingRooms.clear()
  compactingSessions.clear()
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
const fake = () => port as unknown as FakePort
const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, key?: string) =>
  app.inject({
    method,
    url,
    headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload ? { payload } : {}),
  })
async function createRoom(name = 'team') {
  const response = await send('POST', '/api/rooms', {
    name,
    leadAgentId: 'lead',
    members: ['lead', 'builder'],
  })
  expect(response.statusCode).toBe(200)
  return RoomSchema.parse(response.json())
}
async function ask(roomId: string, to = ['builder']) {
  await scheduler.advance(10)
  const response = await send('POST', `/api/rooms/${roomId}/messages`, { text: 'hello', to })
  expect(response.statusCode).toBe(200)
  await scheduler.advance(10)
}
const events = (type: string) =>
  db.sqlite
    .prepare('SELECT seq, ts, type, data FROM events WHERE type = ? ORDER BY seq')
    .all(type)
    .map((row) =>
      StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) as unknown }),
    )
const count = (sql: string, ...args: string[]) =>
  Number((db.sqlite.prepare(sql).get(...args) as { n: number }).n)
const finishRuns = () => db.sqlite.prepare("UPDATE message_runs SET state = 'completed'").run()

test('rename works and names stay unique', async () => {
  const room = await createRoom()
  const other = await createRoom('other')
  const renamed = await send('PATCH', `/api/rooms/${room.id}`, { name: 'launch #q4' })
  expect(renamed.statusCode).toBe(200)
  expect(RoomSchema.parse(renamed.json()).name).toBe('#launch #q4')
  expect(RoomSchema.parse(renamed.json()).tags).toContain('q4')
  expect((await send('PATCH', `/api/rooms/${room.id}`, { name: other.name })).statusCode).toBe(409)
  expect((await send('PATCH', `/api/rooms/${room.id}`, { name: 'Bad Name!' })).statusCode).toBe(400)
})

test('delete: the plan counts, the name must be typed, and everything of the room goes with its event', async () => {
  const room = await createRoom()
  await ask(room.id)
  finishRuns()
  const plan = RoomDeletePlanSchema.parse(
    (await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/delete-plan` })).json(),
  )
  expect(plan).toMatchObject({ name: room.name, blocked: null, runs: 1 })
  expect(plan.messages).toBeGreaterThanOrEqual(1)

  expect((await send('DELETE', `/api/rooms/${room.id}`, { confirm: 'nope' })).statusCode).toBe(400)
  expect((await send('DELETE', `/api/rooms/${room.id}`, {})).statusCode).toBe(400)
  const gone = await send('DELETE', `/api/rooms/${room.id}`, { confirm: room.name })
  expect(gone.statusCode).toBe(204)
  expect(count('SELECT count(*) AS n FROM rooms WHERE id = ?', room.id)).toBe(0)
  expect(count('SELECT count(*) AS n FROM messages WHERE room_id = ?', room.id)).toBe(0)
  expect(count('SELECT count(*) AS n FROM message_runs WHERE room_id = ?', room.id)).toBe(0)
  expect(events('room.deleted').map((event) => event.data)).toEqual([{ id: room.id }])
  expect((await send('DELETE', `/api/rooms/${room.id}`, { confirm: room.name })).statusCode).toBe(
    404,
  )
  // The rooms list no longer has it.
  const list = (await app.inject({ method: 'GET', url: '/api/rooms' })).json() as {
    rooms: { id: string }[]
  }
  expect(list.rooms.map((item) => item.id)).not.toContain(room.id)
})

test('delete is refused for a direct room, a busy room and a rewinding room', async () => {
  const direct = (
    (await app.inject({ method: 'GET', url: '/api/rooms' })).json() as {
      directs: { id: string; name: string }[]
    }
  ).directs[0]!
  const refused = await send('DELETE', `/api/rooms/${direct.id}`, { confirm: direct.name })
  expect(refused.statusCode).toBe(409)
  expect(
    RoomDeletePlanSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/rooms/${direct.id}/delete-plan` })).json(),
    ).blocked,
  ).toBe('direct')

  const room = await createRoom()
  await ask(room.id)
  const busy = await send('DELETE', `/api/rooms/${room.id}`, { confirm: room.name })
  expect(busy.statusCode).toBe(409)
  expect(busy.json().error.code).toBe('room_busy')
  finishRuns()
  rewindingRooms.add(room.id)
  expect(
    (await send('DELETE', `/api/rooms/${room.id}`, { confirm: room.name })).json().error.code,
  ).toBe('room_busy')
  rewindingRooms.delete(room.id)
  expect((await send('DELETE', `/api/rooms/${room.id}`, { confirm: room.name })).statusCode).toBe(
    204,
  )
})

test('delete removes briefs started in the room and releases attachment media once', async () => {
  const room = await createRoom()
  await ask(room.id)
  finishRuns()
  db.sqlite
    .prepare(
      `INSERT INTO media (id, sha256, content_type, size, created_at, last_used_at, refs) VALUES ('m1', ?, 'image/png', 4, 'x', 'x', 1)`,
    )
    .run('a'.repeat(64))
  const mine = db.sqlite
    .prepare("SELECT id FROM messages WHERE room_id = ? AND author_kind = 'you'")
    .get(room.id) as { id: string }
  db.sqlite
    .prepare('UPDATE messages SET parts = ? WHERE id = ?')
    .run(JSON.stringify([{ kind: 'image', mediaId: 'm1', name: 'a.png' }]), mine.id)
  const brief = db.sqlite
    .prepare('SELECT count(*) AS n FROM briefs WHERE room_id = ?')
    .get(room.id) as {
    n: number
  }
  expect((await send('DELETE', `/api/rooms/${room.id}`, { confirm: room.name })).statusCode).toBe(
    204,
  )
  expect(count('SELECT refs AS n FROM media WHERE id = ?', 'm1')).toBe(0)
  expect(brief.n).toBeGreaterThanOrEqual(0)
  expect(count('SELECT count(*) AS n FROM briefs WHERE room_id = ?', room.id)).toBe(0)
})

test('compact: 202 now, session.compacted later with Hermes sizes; turns wait meanwhile', async () => {
  const room = await createRoom()
  const sessionId = `score-${room.id}-builder`
  fake().compactDelayMs = 20
  const accepted = await send('POST', `/api/agents/builder/sessions/${sessionId}/compact`, {
    keepRecent: 3,
  })
  expect(accepted.statusCode).toBe(202)
  const commandId = (accepted.json() as { commandId: string }).commandId
  // In flight: the same session refuses a second request and a new turn of that agent stays pending.
  expect(
    (await send('POST', `/api/agents/builder/sessions/${sessionId}/compact`, {})).json().error.code,
  ).toBe('conflict')
  await ask(room.id)
  expect(count("SELECT count(*) AS n FROM message_runs WHERE state = 'pending'")).toBe(1)
  await vi.waitFor(() => expect(events('session.compacted')).toHaveLength(1), { timeout: 2000 })
  expect(events('session.compacted')[0]!.data).toEqual({
    commandId,
    agentId: 'builder',
    sessionId,
    roomId: room.id,
    status: 'compacted',
    reason: null,
    keepRecent: 3,
    before: { messages: 40, tokens: 54000 },
    after: { messages: 14, tokens: 9000 },
    memoryNote: null,
  })
  expect(fake().compactions).toEqual([{ agentId: 'builder', sessionId, keepRecent: 3 }])
  expect(compactingSessions.size).toBe(0)
})

test('compact refusals: unknown session, unknown agent, busy agent, invalid body', async () => {
  const room = await createRoom()
  const sessionId = `score-${room.id}-builder`
  const url = (agent: string, session: string) => `/api/agents/${agent}/sessions/${session}/compact`
  expect((await send('POST', url('builder', 'score-nope-builder'), {})).statusCode).toBe(404)
  expect((await send('POST', url('nobody', sessionId), {})).statusCode).toBe(404)
  expect((await send('POST', url('builder', 'whatever'), {})).statusCode).toBe(404)
  expect((await send('POST', url('builder', sessionId), { keepRecent: 0 })).statusCode).toBe(400)
  await ask(room.id)
  const busy = await send('POST', url('builder', sessionId), {})
  expect(busy.statusCode).toBe(409)
  expect(busy.json().error.code).toBe('session_busy')
  finishRuns()
  rewindingRooms.add(room.id)
  expect((await send('POST', url('builder', sessionId), {})).json().error.code).toBe('session_busy')
})

test('a failed compaction reports its reason; a second compaction finds nothing to do', async () => {
  const room = await createRoom()
  const sessionId = `score-${room.id}-builder`
  const url = `/api/agents/builder/sessions/${sessionId}/compact`
  fake().compactFailures.set('builder', 'bridge_unavailable')
  expect((await send('POST', url, {})).statusCode).toBe(202)
  await vi.waitFor(() => expect(events('session.compacted')).toHaveLength(1))
  expect(events('session.compacted')[0]!.data).toMatchObject({
    status: 'failed',
    reason: 'bridge_unavailable',
    before: null,
  })
  fake().compactFailures.clear()
  expect((await send('POST', url, {})).statusCode).toBe(202)
  await vi.waitFor(() => expect(events('session.compacted')).toHaveLength(2))
  expect((await send('POST', url, {})).statusCode).toBe(202)
  await vi.waitFor(() => expect(events('session.compacted')).toHaveLength(3))
  expect(events('session.compacted')[2]!.data).toMatchObject({ status: 'nothing' })
})

test('session context: Hermes breakdown when the bridge answers, the totals otherwise; compaction refreshes it', async () => {
  const room = await createRoom()
  const sessionId = `score-${room.id}-builder`
  const read = async () =>
    SessionContextSnapshotSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/agents/builder/sessions/${sessionId}/context`,
        })
      ).json(),
    )
  const full = await read()
  expect(full.parts?.map((part) => part.kind)).toContain('conversation')
  expect(full).toMatchObject({ window: 128000, used: 54000, autoCompactAt: 64000, compactions: 0 })
  fake().compactDelayMs = 0
  await send('POST', `/api/agents/builder/sessions/${sessionId}/compact`, {})
  await vi.waitFor(() => expect(events('session.compacted')).toHaveLength(1))
  const after = await read()
  expect(after.used).toBe(9000)
  expect(after.compactions).toBe(1)
  const process_ = process.env.SCORE_FAKE_NO_BREAKDOWN
  process.env.SCORE_FAKE_NO_BREAKDOWN = '1'
  try {
    await send('PATCH', `/api/rooms/${room.id}`, { pinned: true })
    // The cache is keyed to the turns and compactions seen: drop it through a finished turn.
    await ask(room.id)
    finishRuns()
    const fallback = await read()
    expect(fallback.parts).toBeNull()
    expect(fallback.source).toBeNull()
  } finally {
    if (process_ === undefined) delete process.env.SCORE_FAKE_NO_BREAKDOWN
    else process.env.SCORE_FAKE_NO_BREAKDOWN = process_
  }
  expect(
    (await app.inject({ method: 'GET', url: '/api/agents/builder/sessions/zzz/context' }))
      .statusCode,
  ).toBe(404)
})

test('an imported room that continues a Hermes session compacts that session', async () => {
  const room = await createRoom()
  db.sqlite
    .prepare(
      `INSERT INTO room_sessions (room_id, agent_id, session_id, mode, summary_sent) VALUES (?, 'builder', 'hermes-original', 'same_session', 0)`,
    )
    .run(room.id)
  const url = (session: string) => `/api/agents/builder/sessions/${session}/compact`
  expect((await send('POST', url(`score-${room.id}-builder`), {})).statusCode).toBe(202)
  await vi.waitFor(() => expect(events('session.compacted')).toHaveLength(1))
  expect(fake().compactions).toEqual([{ agentId: 'builder', sessionId: 'hermes-original' }])
  // The event names the id the client asked about.
  expect(events('session.compacted')[0]!.data).toMatchObject({
    sessionId: `score-${room.id}-builder`,
  })
  expect((await send('POST', url('hermes-original'), {})).statusCode).toBe(202)
})
