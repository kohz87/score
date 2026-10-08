import { AgentSummarySchema, RoomSchema, StreamEventSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { applyLifecycle } from '../../src/domain/agent-lifecycle.ts'
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
    [mine.id, 'schedule', 'Paused from Score'],
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

test('a refused park is reported and stays pending; a later pause retries it', async () => {
  const task = await port.createTask({ title: 'Stuck', assignee: 'builder', roomId }, 'a')
  const actions = vi.spyOn(port, 'taskAction').mockRejectedValueOnce(new Error('hermes down'))
  const first = await post('/api/agents/builder/pause', {}, 'p')
  expect(first.statusCode).toBe(502)
  expect(first.json().error.details).toEqual({ taskIds: [task.id] })
  expect(rows('SELECT state FROM agent_paused_tasks')).toEqual([{ state: 'pending' }])
  // The agent still shows as paused, and pausing again finishes the job (as does recovery after a crash).
  expect((await post('/api/agents/builder/pause', {}, 'p2')).statusCode).toBe(200)
  expect(rows('SELECT state FROM agent_paused_tasks')).toEqual([{ state: 'held' }])
  expect((await port.getTask(task.id)).hermesStatus).toBe('scheduled')
  actions.mockClear()
  await post('/api/agents/builder/resume', {}, 'r')
  expect(actions.mock.calls.map(([req]) => req.action)).toEqual(['unblock'])
  expect((await port.getTask(task.id)).hermesStatus).toBe('ready')
})

test('pause never parks a task that has already started', async () => {
  const task = await port.createTask({ title: 'Going', assignee: 'builder', roomId }, 'a')
  // Hermes claimed it between Score's snapshot and the park.
  vi.spyOn(port, 'getTask').mockResolvedValue({
    ...(await port.getTask(task.id)),
    hermesStatus: 'running',
  })
  const actions = vi.spyOn(port, 'taskAction')
  expect((await post('/api/agents/builder/pause', {}, 'p')).statusCode).toBe(200)
  expect(actions).not.toHaveBeenCalled()
  expect(rows('SELECT 1 FROM agent_paused_tasks')).toEqual([])
})

test('pausing twice in a row keeps the task parked and restorable (no triage)', async () => {
  const task = await port.createTask({ title: 'Again', assignee: 'builder', roomId }, 'a')
  for (const round of ['1', '2', '3']) {
    expect((await post('/api/agents/builder/pause', {}, `p${round}`)).statusCode).toBe(200)
    expect((await port.getTask(task.id)).hermesStatus).toBe('scheduled')
    expect((await post('/api/agents/builder/resume', {}, `r${round}`)).statusCode).toBe(200)
    expect((await port.getTask(task.id)).hermesStatus).toBe('ready')
  }
})

test('a task held by two pauses stays parked until the last one resumes', async () => {
  const task = await port.createTask({ title: 'Shared', assignee: 'builder', roomId }, 'a')
  const brief = await send({ text: '/assign @builder Shared work' })
  const briefId = brief.json().message.id as string
  // Link the existing task to the brief so both pauses apply to it.
  db.sqlite
    .prepare(
      "INSERT OR IGNORE INTO brief_tasks (brief_id, task_id, origin, linked_at) VALUES (?, ?, 'assign', 'x')",
    )
    .run(briefId, task.id)
  await post('/api/agents/builder/pause', {}, 'p')
  await post(`/api/briefs/${briefId}/pause`, {}, 'bp')
  expect(rows('SELECT task_id FROM brief_paused_tasks WHERE task_id = ?', task.id)).toHaveLength(1)
  await post(`/api/briefs/${briefId}/resume`, {}, 'br')
  expect((await port.getTask(task.id)).hermesStatus).toBe('scheduled')
  await post('/api/agents/builder/resume', {}, 'r')
  expect((await port.getTask(task.id)).hermesStatus).toBe('ready')
})

test('resume while the park is still in flight waits for it and leaves nothing parked', async () => {
  const task = await port.createTask({ title: 'Racing', assignee: 'builder', roomId }, 'a')
  const real = port.taskAction.bind(port)
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  vi.spyOn(port, 'taskAction').mockImplementation(async (req) => {
    if (req.action === 'schedule') await gate
    return real(req)
  })
  const pausing = post('/api/agents/builder/pause', {}, 'p')
  await vi.waitFor(() => expect(rows('SELECT 1 FROM agent_paused_tasks')).toHaveLength(1))
  const resuming = post('/api/agents/builder/resume', {}, 'r')
  release()
  await Promise.all([pausing, resuming])
  expect((await port.getTask(task.id)).hermesStatus).toBe('ready')
  expect(rows('SELECT 1 FROM agent_paused_tasks')).toEqual([])
})

test('a paused agent that goes offline still reads as paused, so Resume stays reachable', async () => {
  expect((await post('/api/agents/lead/pause')).statusCode).toBe(200)
  const lead = (await port.listAgentDetails()).find((agent) => agent.id === 'lead')!
  const shown = applyLifecycle(db.sqlite, { ...lead, status: 'offline', activity: null })
  expect(shown).toMatchObject({ status: 'paused', activity: 'Paused' })
})

test('recovery runs when asked (after the adapter starts), not when the app becomes ready', async () => {
  const task = await port.createTask({ title: 'Pending', assignee: 'builder', roomId }, 'a')
  db.sqlite.prepare("INSERT INTO agent_pauses (agent_id, paused_at) VALUES ('builder', 'x')").run()
  db.sqlite
    .prepare(
      "INSERT INTO agent_paused_tasks (agent_id, task_id, blocked_at, state) VALUES ('builder', ?, 'x', 'pending')",
    )
    .run(task.id)
  const read = vi.spyOn(port, 'getTask')
  await app.ready()
  expect(read).not.toHaveBeenCalled()
  expect(await app.recoverTaskHolds!()).toBe(0)
  expect((await port.getTask(task.id)).hermesStatus).toBe('scheduled')
  expect(rows('SELECT state FROM agent_paused_tasks')).toEqual([{ state: 'held' }])
})

test('recovery releases confirmed holds of an owner that was resumed before the release finished', async () => {
  const task = await port.createTask({ title: 'Held', assignee: 'builder', roomId }, 'a')
  await post('/api/agents/builder/pause', {}, 'p')
  expect((await port.getTask(task.id)).hermesStatus).toBe('scheduled')
  // Resume cleared the pause, then the server stopped before unparking.
  db.sqlite.prepare('DELETE FROM agent_pauses').run()
  expect(await app.recoverTaskHolds!()).toBe(0)
  expect((await port.getTask(task.id)).hermesStatus).toBe('ready')
  expect(rows('SELECT 1 FROM agent_paused_tasks')).toEqual([])
})

test('a task blocked by the previous implementation (legacy hold) is unblocked on resume', async () => {
  const task = await port.createTask({ title: 'Old pause', assignee: 'builder', roomId }, 'a')
  await port.taskAction({ taskId: task.id, action: 'block', text: 'Paused from Score' })
  db.sqlite.prepare("INSERT INTO agent_pauses (agent_id, paused_at) VALUES ('builder', 'x')").run()
  db.sqlite
    .prepare(
      "INSERT INTO agent_paused_tasks (agent_id, task_id, blocked_at, state, legacy) VALUES ('builder', ?, 'x', 'held', 1)",
    )
    .run(task.id)
  expect((await post('/api/agents/builder/resume', {}, 'r')).statusCode).toBe(200)
  expect((await port.getTask(task.id)).hermesStatus).toBe('ready')
  expect(rows('SELECT 1 FROM agent_paused_tasks')).toEqual([])
})

test('when the park is uncertain and the follow-up read fails too, the intent stays pending', async () => {
  const task = await port.createTask({ title: 'Unknown', assignee: 'builder', roomId }, 'a')
  const original = port.getTask.bind(port)
  let reads = 0
  vi.spyOn(port, 'getTask').mockImplementation((id) =>
    ++reads === 1 ? original(id) : Promise.reject(new Error('hermes down')),
  )
  vi.spyOn(port, 'taskAction').mockRejectedValueOnce(new Error('timed out'))
  const response = await post('/api/agents/builder/pause', {}, 'p')
  expect(response.statusCode).toBe(502)
  expect(response.json().error.details).toEqual({ taskIds: [task.id] })
  expect(rows('SELECT state FROM agent_paused_tasks')).toEqual([{ state: 'pending' }])
})
