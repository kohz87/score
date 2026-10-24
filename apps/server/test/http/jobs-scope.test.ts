import {
  MessageSearchResponseSchema,
  RoomDetailSnapshotSchema,
  RoomSchema,
  RoomsSnapshotSchema,
  RewindPlanSchema,
  ShareCreatedSchema,
  StreamEventSchema,
  type Message,
} from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { SecurityPassword } from '../../src/auth/security-password.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { defaultJobId } from '../../src/domain/job-sessions.ts'
import { storeMessage } from '../../src/domain/rooms.ts'
import { ensureTeamRoom, teamRoomId } from '../../src/domain/team-room.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

// PLAN 11.1b HTTP boundary: a jobId names one thread; the room's other job stays untouched.
const PASSWORD = 'correct horse battery'
const at = (second: number) => new Date(Date.UTC(2026, 9, 24, 13, 0, second)).toISOString()
const SECOND_JOB = 'job_second'
let dir: string
let db: ScoreDb
let ingest: Ingest
let port: HermesPort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-job-scope-http-'))
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
    security: new SecurityPassword(dir, clock),
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
  vi.spyOn(port, 'startRun').mockResolvedValue({ runId: 'job-scope-run' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const get = (url: string) => app.inject({ method: 'GET', url })
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload })
const patch = (url: string, payload: object) =>
  app.inject({ method: 'PATCH', url, headers, payload })
async function createRoom(name = 'scope') {
  const response = await post('/api/rooms', {
    name,
    leadAgentId: 'lead',
    members: ['lead', 'builder', 'reviewer'],
  })
  expect(response.statusCode).toBe(200)
  return RoomSchema.parse(response.json())
}
function addJob(roomId: string, id = SECOND_JOB, title = 'Second thread') {
  db.sqlite
    .prepare(
      "INSERT INTO jobs (id, room_id, title, session_scheme, created_at, updated_at) VALUES (?, ?, ?, 'job', ?, ?)",
    )
    .run(id, roomId, title, at(0), at(0))
  return id
}
function say(
  roomId: string,
  jobId: string,
  id: string,
  text: string,
  second: number,
  author: Message['author'] = { kind: 'you' },
) {
  const message: Message = {
    id,
    roomId,
    jobId,
    author,
    to: [],
    parts: [{ kind: 'text', text }],
    refs: [],
    createdAt: at(second),
    streaming: false,
  }
  storeMessage(db.sqlite, message, at(second))
  return message
}
function addTurn(roomId: string, parentId: string, agentId: string, runId: string) {
  const parent = db.sqlite
    .prepare('SELECT created_at FROM messages WHERE id = ?')
    .get(parentId) as { created_at: string }
  db.sqlite
    .prepare(
      "INSERT OR IGNORE INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, ?, 'score', 'completed', ?, ?)",
    )
    .run(runId, agentId, parent.created_at, parent.created_at)
  db.sqlite
    .prepare(
      `INSERT INTO message_runs
       (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'x', '[]', 'completed', ?)`,
    )
    .run(
      `reply:${runId}`,
      runId,
      roomId,
      agentId,
      parentId,
      `turn-${runId}`,
      parentId,
      parent.created_at,
    )
}
function events() {
  return db.sqlite
    .prepare('SELECT seq, ts, type, data FROM events ORDER BY seq')
    .all()
    .map((row) =>
      StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) as unknown }),
    )
}
async function setPassword() {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/session/security/password',
    headers,
    payload: { password: PASSWORD },
  })
  expect(response.statusCode).toBe(204)
}
const share = (roomId: string, payload: object = {}) =>
  app.inject({
    method: 'POST',
    url: `/api/rooms/${roomId}/shares`,
    headers,
    payload: { password: PASSWORD, ...payload },
  })
const snapshotOf = (id: string) =>
  JSON.parse(
    (
      db.sqlite.prepare('SELECT snapshot FROM room_shares WHERE id = ?').get(id) as {
        snapshot: string
      }
    ).snapshot,
  ) as { title: string; messages: { text: string }[] }

test('a message with jobId stores its reply and message.created event in that job only', async () => {
  const room = await createRoom()
  const job = defaultJobId(db.sqlite, room.id)!
  const second = addJob(room.id)
  say(room.id, job, 'default-seed', 'default seed', 1)
  say(room.id, second, 'second-seed', 'second seed', 1)
  addTurn(room.id, 'default-seed', 'builder', 'default-turn')
  addTurn(room.id, 'second-seed', 'builder', 'second-turn')
  const defaultBefore = db.sqlite
    .prepare('SELECT * FROM messages WHERE job_id = ? ORDER BY id')
    .all(job)

  const response = await post(`/api/rooms/${room.id}/messages`, {
    text: 'post into the second job',
    to: ['builder'],
    jobId: second,
  })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { message: { id: string; jobId: string } }
  expect(body.message.jobId).toBe(second)
  expect(
    db.sqlite.prepare('SELECT job_id FROM messages WHERE id = ?').get(body.message.id),
  ).toEqual({ job_id: second })
  expect(
    events().find((event) => event.type === 'message.created' && event.data.id === body.message.id),
  ).toMatchObject({ type: 'message.created', data: { jobId: second } })
  expect(
    db.sqlite
      .prepare('SELECT job_id FROM message_runs WHERE parent_message_id = ?')
      .all(body.message.id),
  ).toEqual([{ job_id: second }])
  expect(db.sqlite.prepare('SELECT * FROM messages WHERE job_id = ? ORDER BY id').all(job)).toEqual(
    defaultBefore,
  )
})

test('a jobId from another room is 404', async () => {
  const room = await createRoom()
  const other = await createRoom('other')
  const otherJob = addJob(other.id, 'job_other', 'Other thread')
  const job = defaultJobId(db.sqlite, room.id)!
  say(room.id, job, 'default-only', 'default only', 1)

  const response = await post(`/api/rooms/${room.id}/messages`, {
    text: 'wrong room',
    jobId: otherJob,
  })
  expect(response.statusCode).toBe(404)
  expect(db.sqlite.prepare('SELECT id FROM messages WHERE id = ?').get('default-only')).toEqual({
    id: 'default-only',
  })
})

test('an edit stays in its original job and a different jobId is refused', async () => {
  const room = await createRoom()
  const job = defaultJobId(db.sqlite, room.id)!
  const second = addJob(room.id)
  say(room.id, job, 'default-seed', 'default seed', 1)
  const originalId = say(room.id, second, 'original-second', 'original in second', 2).id

  const mismatch = await post(`/api/rooms/${room.id}/messages`, {
    text: 'wrong job correction',
    edits: originalId,
    jobId: job,
  })
  expect(mismatch.statusCode).toBe(400)

  const correction = await post(`/api/rooms/${room.id}/messages`, {
    text: 'corrected',
    edits: originalId,
  })
  expect(correction.statusCode).toBe(200)
  expect(
    (correction.json() as { message: { jobId: string; edits: string } }).message,
  ).toMatchObject({ jobId: second, edits: originalId })
  expect(db.sqlite.prepare('SELECT job_id FROM messages WHERE id = ?').get('default-seed')).toEqual(
    {
      job_id: job,
    },
  )
})

test("the rewind plan counts only the anchor's job", async () => {
  const room = await createRoom()
  const job = defaultJobId(db.sqlite, room.id)!
  const second = addJob(room.id)
  say(room.id, job, 'd-before', 'default before', 1)
  say(room.id, job, 'd-anchor-at', 'default anchor time', 2)
  say(room.id, job, 'd-after', 'default after', 3)
  say(room.id, second, 'j-before', 'second before', 1)
  say(room.id, second, 'j-anchor', 'second anchor', 2)
  say(room.id, second, 'j-after', 'second after', 3)
  addTurn(room.id, 'd-anchor-at', 'builder', 'default-run')
  addTurn(room.id, 'j-anchor', 'builder', 'second-run')

  const response = await get(`/api/rooms/${room.id}/messages/j-anchor/rewind-plan`)
  expect(response.statusCode).toBe(200)
  expect(RewindPlanSchema.parse(response.json())).toEqual({
    hiddenCount: 2,
    blocked: null,
    agents: [{ agentId: 'builder', turns: 1, cannot: null }],
  })
})

test('search returns every hit with its jobId and filters by jobId', async () => {
  const room = await createRoom()
  const job = defaultJobId(db.sqlite, room.id)!
  const second = addJob(room.id)
  say(room.id, job, 'search-default', 'postgres default needle', 1)
  say(room.id, second, 'search-second', 'postgres second needle', 2)

  const all = MessageSearchResponseSchema.parse(
    (await get('/api/search/messages?q=postgres')).json(),
  )
  expect(all.items.map((item) => item.jobId).sort()).toEqual([job, second].sort())
  expect(all.items).toHaveLength(2)
  const filtered = MessageSearchResponseSchema.parse(
    (await get(`/api/search/messages?q=postgres&jobId=${second}`)).json(),
  )
  expect(filtered.items).toMatchObject([{ messageId: 'search-second', jobId: second }])
})

test('shares snapshot one job; no jobId means the default job and the room title', async () => {
  await setPassword()
  const room = await createRoom('shared')
  const job = defaultJobId(db.sqlite, room.id)!
  const second = addJob(room.id)
  const other = await createRoom('other')
  const otherJob = addJob(other.id, 'job_other', 'Other thread')
  say(room.id, job, 'share-default', 'default share text', 1)
  say(room.id, second, 'share-second', 'second share text', 2)

  const secondShare = ShareCreatedSchema.parse((await share(room.id, { jobId: second })).json())
  expect(snapshotOf(secondShare.id)).toEqual({
    title: 'Second thread',
    messages: [{ who: 'You', you: true, at: at(2), text: 'second share text', images: [] }],
    images: [],
  })
  const defaultShare = ShareCreatedSchema.parse((await share(room.id)).json())
  expect(snapshotOf(defaultShare.id)).toEqual({
    title: '#shared',
    messages: [{ who: 'You', you: true, at: at(1), text: 'default share text', images: [] }],
    images: [],
  })
  expect((await share(room.id, { jobId: otherJob })).statusCode).toBe(404)
})

test('the classic room list leaves the team room out while its detail route returns it', async () => {
  const normal = await createRoom('normal')
  ensureTeamRoom(db.sqlite, ['lead', 'builder'], at(1))
  const teamId = teamRoomId(db.sqlite)!

  const list = RoomsSnapshotSchema.parse((await get('/api/rooms')).json())
  expect(list.rooms.map((room) => room.id)).toEqual([normal.id])
  expect(list.directs.map((room) => room.id)).not.toContain(teamId)
  const detail = RoomDetailSnapshotSchema.parse((await get(`/api/rooms/${teamId}`)).json())
  expect(detail.room).toMatchObject({ id: teamId, role: 'team', routing: 'exchanges' })
})

test('renaming a room renames its default job and leaves another job untouched', async () => {
  const room = await createRoom('release')
  const job = defaultJobId(db.sqlite, room.id)!
  const second = addJob(room.id)
  say(room.id, job, 'rename-default', 'default message', 1)
  say(room.id, second, 'rename-second', 'second message', 2)
  const secondBefore = db.sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(second)
  const messagesBefore = db.sqlite.prepare('SELECT * FROM messages ORDER BY id').all()

  const response = await patch(`/api/rooms/${room.id}`, { name: 'renamed' })
  expect(response.statusCode).toBe(200)
  expect(db.sqlite.prepare('SELECT title FROM jobs WHERE id = ?').get(job)).toEqual({
    title: '#renamed',
  })
  expect(db.sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(second)).toEqual(secondBefore)
  expect(db.sqlite.prepare('SELECT * FROM messages ORDER BY id').all()).toEqual(messagesBefore)
})
