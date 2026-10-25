import { MessageSchema, NowSnapshotSchema, RoomSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { deriveBriefEvents } from '../../src/domain/briefs.ts'
import { deriveTaskEvents } from '../../src/domain/tasks.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { onMentions } from '../helpers/on-mentions.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let roomId: string
let replies: Record<string, string>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-team-pause-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, {
    clock,
    deriveEvents: (sqlite, drafts, context) => [
      ...deriveTaskEvents(sqlite, drafts, context),
      ...deriveBriefEvents(sqlite, drafts, context),
    ],
  })
  replies = {}
  port = new FakePort(1, { db, scheduler }, false, (req) => ({
    text: replies[req.agentId] ?? 'The streamed reply is ready.',
    tools: ['terminal', 'edit_file'],
  }))
  await port.start(ingest)
  // The script's first timer is the only one armed; dropping it keeps the demo scenario out of these tests.
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
  roomId = RoomSchema.parse(
    (await post('/api/rooms', { name: 'briefs', leadAgentId: 'lead' })).json(),
  ).id
  onMentions(db, roomId)
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const post = (url: string, payload: object = {}, key?: string, authed = true) =>
  app.inject({
    method: 'POST',
    url,
    headers: authed
      ? { ...headers, ...(key ? { 'idempotency-key': key } : {}) }
      : { 'x-score-client': 'web' },
    payload,
  })
const get = (url: string) => app.inject({ url })
const send = (payload: object, key?: string) => post(`/api/rooms/${roomId}/messages`, payload, key)
async function advance(ms: number) {
  await scheduler.advance(ms)
  await ingest.flushListeners()
  await ingest.drain()
}
const rows = (sql: string, ...args: string[]) => db.sqlite.prepare(sql).all(...args)
async function ask(text: string, extra: object = {}): Promise<string> {
  const response = await send({ text, ...extra })
  expect(response.statusCode).toBe(200)
  return MessageSchema.parse(response.json().message).id
}

test('pause everyone holds every brief and the queue; resume releases them', async () => {
  replies.lead = '@builder please continue'
  const run = vi.spyOn(port, 'startRun')
  const id = await ask('hello')
  expect(run.mock.calls.map(([req]) => req.agentId)).toEqual(['lead'])
  expect((await post('/api/team/pause', {}, undefined, false)).statusCode).toBe(401)
  const paused = await post('/api/team/pause')
  expect(paused.statusCode).toBe(200)
  expect(paused.json()).toEqual({ paused: true, affectedRuns: expect.any(Number) })
  expect(rows('SELECT brief_id FROM team_paused_briefs')).toEqual([{ brief_id: id }])
  expect(rows('SELECT paused_at FROM team_state')[0]!.paused_at).not.toBeNull()
  await advance(4000)
  // The lead's turn finished, but its hand-off waits for the resume.
  expect(run.mock.calls.map(([req]) => req.agentId)).toEqual(['lead'])
  const now = NowSnapshotSchema.parse((await get('/api/now')).json())
  expect(now.headline.text.startsWith('Everyone is paused.')).toBe(true)
  expect(rows('SELECT paused_at FROM briefs WHERE id = ?', id)[0]!.paused_at).not.toBeNull()
  const resumed = await post('/api/team/resume')
  expect(resumed.statusCode).toBe(200)
  expect(resumed.json()).toMatchObject({ paused: false })
  expect(rows('SELECT brief_id FROM team_paused_briefs')).toEqual([])
  await advance(4000)
  expect(run.mock.calls.map(([req]) => req.agentId)).toEqual(['lead', 'builder'])
  expect(
    NowSnapshotSchema.parse((await get('/api/now')).json()).headline.text.startsWith('Everyone'),
  ).toBe(false)
})

test('resume everyone leaves a brief the person paused on its own alone', async () => {
  const mine = await ask('mine')
  // A brief can be paused on its own by an orchestration or workflow run; Team Resume must not lift that hold.
  db.sqlite.prepare('UPDATE briefs SET paused_at = ? WHERE id = ?').run('x', mine)
  await post('/api/team/pause')
  expect(rows('SELECT brief_id FROM team_paused_briefs')).toEqual([])
  await post('/api/team/resume')
  expect(rows('SELECT paused_at FROM briefs WHERE id = ?', mine)).toEqual([{ paused_at: 'x' }])
})
