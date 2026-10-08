import { AgentSummarySchema, RoomSchema, StreamEventSchema } from '@score/contract'
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
  dir = mkdtempSync(join(tmpdir(), 'score-agent-pause-'))
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
const send = (payload: object) => post(`/api/rooms/${roomId}/messages`, payload)
const rows = (sql: string, ...args: string[]) => db.sqlite.prepare(sql).all(...args)
const agentEvents = () =>
  rows("SELECT * FROM events WHERE type = 'agent.updated' ORDER BY seq").map((row) =>
    StreamEventSchema.parse({ ...row, data: JSON.parse(String(row.data)) as unknown }),
  )
async function advance(ms: number) {
  await scheduler.advance(ms)
  await ingest.flushListeners()
  await ingest.drain()
}

test('pause holds the agent queue and blocks only its not-started tasks; resume unblocks only those', async () => {
  const make = (title: string, key: string, assignee: string) =>
    port.createTask({ title, assignee, roomId }, key)
  const mine = await make('Not started', 'a', 'builder')
  const other = await make('Someone else', 'b', 'reviewer')
  const blockedByMe = await make('Blocked by the person', 'c', 'builder')
  await port.taskAction({ taskId: blockedByMe.id, action: 'block', text: 'Mine' })
  const actions = vi.spyOn(port, 'taskAction')

  expect((await post('/api/agents/builder/pause', {}, 'p', false)).statusCode).toBe(401)
  expect((await post('/api/agents/nobody/pause')).statusCode).toBe(404)
  const paused = await post('/api/agents/builder/pause', {}, 'p1')
  expect(paused.statusCode).toBe(200)
  expect(AgentSummarySchema.parse(paused.json())).toMatchObject({ id: 'builder', status: 'paused' })
  expect(actions.mock.calls.map(([req]) => [req.taskId, req.action, req.text])).toEqual([
    [mine.id, 'block', 'Paused from Score'],
  ])
  expect((await port.getTask(other.id)).hermesStatus).not.toBe('blocked')
  expect(agentEvents().at(-1)).toMatchObject({ data: { id: 'builder', status: 'paused' } })

  // The queue is held: a turn for the paused agent does not start, one for another agent does.
  const run = vi.spyOn(port, 'startRun')
  await send({ text: '@builder please look' })
  await send({ text: '@reviewer please look' })
  await advance(100)
  expect(run.mock.calls.map(([req]) => req.agentId)).toEqual(['reviewer'])

  actions.mockClear()
  await post('/api/agents/builder/pause', {}, 'p2')
  expect(actions).not.toHaveBeenCalled()

  const resumed = await post('/api/agents/builder/resume', {}, 'r1')
  expect(resumed.statusCode).toBe(200)
  expect(AgentSummarySchema.parse(resumed.json()).status).not.toBe('paused')
  expect(actions.mock.calls.map(([req]) => [req.taskId, req.action, req.text])).toEqual([
    [mine.id, 'unblock', 'Resumed from Score'],
  ])
  expect((await port.getTask(blockedByMe.id)).hermesStatus).toBe('blocked')
  expect(rows('SELECT 1 FROM agent_pauses')).toEqual([])
  expect(rows('SELECT 1 FROM agent_paused_tasks')).toEqual([])
  await advance(100)
  expect(run.mock.calls.map(([req]) => req.agentId)).toContain('builder')
  actions.mockClear()
  expect((await post('/api/agents/builder/resume', {}, 'r2')).statusCode).toBe(200)
  expect(actions).not.toHaveBeenCalled()
})

test('a failed block is forgotten, so resume never touches that task', async () => {
  const task = await port.createTask({ title: 'Stuck', assignee: 'builder', roomId }, 'a')
  const actions = vi.spyOn(port, 'taskAction').mockRejectedValueOnce(new Error('hermes down'))
  expect((await post('/api/agents/builder/pause', {}, 'p')).statusCode).toBe(200)
  expect(rows('SELECT task_id FROM agent_paused_tasks')).toEqual([])
  actions.mockClear()
  await post('/api/agents/builder/resume', {}, 'r')
  expect(actions).not.toHaveBeenCalled()
  expect((await port.getTask(task.id)).hermesStatus).not.toBe('blocked')
})
