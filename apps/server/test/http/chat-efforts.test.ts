import { AgentEffortsSchema, ChatEffortsResponseSchema, type Job } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { ensureTeamRoom } from '../../src/domain/team-room.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

let dir: string
let db: ScoreDb
let port: FakePort
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let job: Job
let roomId: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-chat-efforts-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  const scheduler = new FakeScheduler()
  const ingest = createIngest(db, { clock: () => scheduler.now() })
  port = new FakePort(1, { db, scheduler }, false, () => ({ text: 'Working on it.', tools: [] }))
  await port.start(ingest)
  db.tx((sqlite) => ensureTeamRoom(sqlite, ['lead', 'builder'], new Date().toISOString()))
  app = buildApp({ config: loadConfig({ SCORE_MODE: 'fake' }), logger: false, db, ingest, port })
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
  const room = (await app.inject({ method: 'GET', url: '/api/team-room', headers })).json() as {
    jobs: Job[]
  }
  job = room.jobs[0]!
  roomId = job.roomId
})
afterEach(async () => {
  await app.close()
  await port.stop()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const put = (agentId: string, effort: string | null) =>
  app.inject({
    method: 'PUT',
    url: `/api/rooms/${roomId}/efforts/${agentId}`,
    headers: { ...headers, 'idempotency-key': `effort-${agentId}-${effort}` },
    payload: { effort },
  })

test('a chat sets an agent’s effort, lists it, and goes back to its own', async () => {
  expect((await put('builder', 'high')).statusCode).toBe(200)
  const list = await app.inject({ method: 'GET', url: `/api/rooms/${roomId}/efforts`, headers })
  expect(ChatEffortsResponseSchema.parse(list.json()).items).toEqual([
    { roomId, agentId: 'builder', effort: 'high' },
  ])
  const agent = await app.inject({ method: 'GET', url: '/api/agents/builder/efforts', headers })
  expect(AgentEffortsSchema.parse(agent.json())).toMatchObject({
    agentId: 'builder',
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    chats: [{ roomId, effort: 'high' }],
  })
  expect((await put('builder', null)).json()).toEqual({ roomId, agentId: 'builder', effort: null })
  const after = await app.inject({ method: 'GET', url: `/api/rooms/${roomId}/efforts`, headers })
  expect(ChatEffortsResponseSchema.parse(after.json()).items).toEqual([])
})

test('a level the agent doesn’t take, or an agent not in the chat, is refused', async () => {
  const wrong = await put('builder', 'ultra')
  expect(wrong.statusCode).toBe(400)
  expect(wrong.json().error.message).toContain('low, medium, high, xhigh, max')
  expect((await put('designer', 'high')).statusCode).toBe(400)
  const nowhere = await app.inject({
    method: 'PUT',
    url: '/api/rooms/nope/efforts/builder',
    headers: { ...headers, 'idempotency-key': 'nope' },
    payload: { effort: 'high' },
  })
  expect(nowhere.statusCode).toBe(404)
})

test('changing an effort needs a paired browser', async () => {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/rooms/${roomId}/efforts/builder`,
    headers: { 'x-score-client': 'web', 'idempotency-key': 'unpaired' },
    payload: { effort: 'high' },
  })
  expect(response.statusCode).toBe(401)
})

test('going back to its own is allowed for an agent no longer in the chat', async () => {
  expect((await put('builder', 'high')).statusCode).toBe(200)
  db.tx((sqlite) =>
    sqlite.prepare(`UPDATE rooms SET members = '["lead"]' WHERE id = ?`).run(roomId),
  )
  expect((await put('builder', null)).statusCode).toBe(200)
  expect((await put('builder', 'low')).statusCode).toBe(400)
})
