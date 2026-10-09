import { MessageSchema, PlanStartResponseSchema, RoomSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { HttpError } from '../../src/errors.ts'
import { linkTask } from '../../src/domain/briefs.ts'
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
  dir = mkdtempSync(join(tmpdir(), 'score-arrival-holds-'))
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
async function advance(ms: number) {
  await scheduler.advance(ms)
  await ingest.flushListeners()
  await ingest.drain()
}

const status = async (taskId: string) => (await port.getTask(taskId)).hermesStatus
const link = (briefId: string, taskId: string) =>
  ingest.submit({
    source: 'test',
    identity: `link-${taskId}`,
    apply: ({ sqlite, now }) => {
      linkTask(sqlite, briefId, taskId, 'assign', now)
      return []
    },
  })

test('a child created by a running step after Pause is held, and released by Resume', async () => {
  const first = await port.createTask({ title: 'Step', assignee: 'builder', roomId }, 'step')
  const id = MessageSchema.parse((await send({ text: 'Do the thing' })).json().message).id
  await link(id, first.id)
  expect((await post(`/api/briefs/${id}/pause`, {}, 'p1')).statusCode).toBe(200)
  const child = await port.createTask(
    { title: 'Child', assignee: 'reviewer', roomId, dependsOn: [first.id] },
    'child',
  )
  await ingest.flushListeners()
  expect(rows('SELECT task_id FROM brief_tasks WHERE brief_id = ?', id)).toContainEqual({
    task_id: child.id,
  })
  expect(rows('SELECT task_id, state FROM brief_paused_tasks')).toContainEqual({
    task_id: child.id,
    state: 'held',
  })
  expect(await status(child.id)).toBe('scheduled')
  expect((await post(`/api/briefs/${id}/resume`, {}, 'r1')).statusCode).toBe(200)
  expect(await status(child.id)).not.toBe('scheduled')
  expect(rows('SELECT 1 FROM brief_paused_tasks')).toEqual([])
})

test('a task assigned to a paused agent is held on arrival', async () => {
  expect((await post('/api/agents/builder/pause', {}, 'p1')).statusCode).toBe(200)
  const mine = await port.createTask({ title: 'Mine', assignee: 'builder', roomId }, 'mine')
  const other = await port.createTask({ title: 'Other', assignee: 'reviewer', roomId }, 'other')
  await ingest.flushListeners()
  expect(await status(mine.id)).toBe('scheduled')
  expect(await status(other.id)).not.toBe('scheduled')
  expect(rows('SELECT task_id, state FROM agent_paused_tasks')).toEqual([
    { task_id: mine.id, state: 'held' },
  ])
  expect((await post('/api/agents/builder/resume', {}, 'r1')).statusCode).toBe(200)
  expect(await status(mine.id)).not.toBe('scheduled')
  expect(rows('SELECT 1 FROM agent_paused_tasks')).toEqual([])
})

test('a task created while the team is paused is held until everyone resumes', async () => {
  expect((await post('/api/team/pause')).statusCode).toBe(200)
  const made = await port.createTask({ title: 'Late', assignee: 'builder', roomId }, 'late')
  await ingest.flushListeners()
  expect(await status(made.id)).toBe('scheduled')
  expect(rows('SELECT task_id, state FROM team_paused_tasks')).toEqual([
    { task_id: made.id, state: 'held' },
  ])
  expect((await post('/api/team/resume')).statusCode).toBe(200)
  expect(await status(made.id)).not.toBe('scheduled')
  expect(rows('SELECT 1 FROM team_paused_tasks')).toEqual([])
})

test('a hold recorded but not parked (crash) is finished by recovery', async () => {
  expect((await post('/api/team/pause')).statusCode).toBe(200)
  const actions = vi.spyOn(port, 'taskAction').mockRejectedValueOnce(new Error('down'))
  const made = await port.createTask({ title: 'Late', assignee: 'builder', roomId }, 'late')
  await ingest.flushListeners()
  expect(await status(made.id)).not.toBe('scheduled')
  expect(rows('SELECT state FROM team_paused_tasks')).toEqual([{ state: 'pending' }])
  actions.mockRestore()
  expect(await app.recoverTaskHolds!()).toBe(0)
  expect(await status(made.id)).toBe('scheduled')
})

const PLAN = ['- [ ] @builder Build it', '- [ ] @reviewer Review it'].join('\n')
async function planMessage() {
  replies.lead = PLAN
  const id = MessageSchema.parse(
    (await send({ text: 'Ship it', planFirst: true })).json().message,
  ).id
  await advance(4000)
  const page = (await app.inject({ url: `/api/rooms/${roomId}/messages`, headers })).json()
  const reply = (page.items as { id: string; parts: { kind: string }[] }[]).find((message) =>
    message.parts.some((part) => part.kind === 'plan'),
  )!
  return { briefId: id, messageId: reply.id }
}
const startUrl = (messageId: string) => `/api/rooms/${roomId}/messages/${messageId}/plan/start`

test('a crash between plan steps is finished at startup with the same step keys', async () => {
  const { briefId, messageId } = await planMessage()
  const create = vi.spyOn(port, 'createTask')
  const real = Object.getPrototypeOf(port).createTask.bind(port)
  create.mockImplementationOnce(real)
  create.mockRejectedValueOnce(new Error('crash'))
  expect((await post(startUrl(messageId), {}, 'k1')).statusCode).toBe(500)
  expect(rows('SELECT state, task_ids FROM plan_start_runs')).toEqual([
    { state: 'running', task_ids: expect.stringMatching(/^\["/) },
  ])
  create.mockImplementation(real)
  expect(await app.recoverPlanStarts!()).toBe(0)
  const run = rows('SELECT state, task_ids FROM plan_start_runs')[0]!
  expect(run.state).toBe('done')
  expect(JSON.parse(String(run.task_ids))).toHaveLength(2)
  expect(await port.listTasks()).toHaveLength(2)
  expect(rows('SELECT 1 FROM brief_tasks WHERE brief_id = ?', briefId)).toHaveLength(2)
  const again = PlanStartResponseSchema.parse((await post(startUrl(messageId), {}, 'k2')).json())
  expect(again.taskIds).toEqual(JSON.parse(String(run.task_ids)))
})

test('a plan start that cannot be finished is marked failed with a notice in the room, and can be restarted', async () => {
  const { messageId } = await planMessage()
  const create = vi.spyOn(port, 'createTask')
  const real = Object.getPrototypeOf(port).createTask.bind(port)
  create.mockImplementationOnce(real)
  create.mockRejectedValueOnce(new Error('crash'))
  await post(startUrl(messageId), {}, 'k1')
  create.mockRejectedValueOnce(new HttpError(409, 'conflict', 'Hermes rejected the task mutation'))
  expect(await app.recoverPlanStarts!()).toBe(0)
  expect(rows('SELECT state FROM plan_start_runs')).toEqual([{ state: 'failed' }])
  const notice = rows('SELECT parts FROM messages WHERE id = ?', `plan-start-failed:${messageId}`)
  expect(String(notice[0]?.parts)).toContain('could not be started')
  create.mockImplementation(real)
  const done = await post(startUrl(messageId), {}, 'k2')
  expect(PlanStartResponseSchema.parse(done.json()).taskIds).toHaveLength(2)
  expect(rows('SELECT state FROM plan_start_runs')).toEqual([{ state: 'done' }])
})

test('Pause landing while a plan step is being created still holds that step', async () => {
  const { briefId, messageId } = await planMessage()
  const create = vi.spyOn(port, 'createTask')
  const real = Object.getPrototypeOf(port).createTask.bind(port)
  create.mockImplementationOnce(async (...args: unknown[]) => {
    const task = await real(...args)
    expect((await post(`/api/briefs/${briefId}/pause`, {}, 'p1')).statusCode).toBe(200)
    return task
  })
  create.mockImplementation(real)
  const started = await post(startUrl(messageId), {}, 'k1')
  expect(started.statusCode).toBe(409)
  await ingest.flushListeners()
  const [first] = rows('SELECT task_id FROM brief_tasks WHERE brief_id = ?', briefId)
  expect(first).toBeDefined()
  expect(await status(String(first!.task_id))).toBe('scheduled')
  expect(rows('SELECT state FROM brief_paused_tasks')).toEqual([{ state: 'held' }])
  expect(await port.listTasks()).toHaveLength(1)
})

test('a failed park of an arrived task is retried without another task event', async () => {
  expect((await post('/api/team/pause')).statusCode).toBe(200)
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    vi.spyOn(port, 'taskAction').mockRejectedValueOnce(new Error('down'))
    const made = await port.createTask({ title: 'Late', assignee: 'builder', roomId }, 'late')
    await ingest.flushListeners()
    expect(await status(made.id)).not.toBe('scheduled')
    await vi.advanceTimersByTimeAsync(6_000)
    await ingest.flushListeners()
    expect(await status(made.id)).toBe('scheduled')
    expect(rows('SELECT state FROM team_paused_tasks')).toEqual([{ state: 'held' }])
  } finally {
    vi.useRealTimers()
  }
})

test('Pause everyone holds a standalone task that already exists, and Resume releases it (gate 2026-10-09)', async () => {
  const standing = await port.createTask(
    { title: 'Standing', assignee: 'builder', roomId },
    'standing',
  )
  await ingest.flushListeners()
  expect(await status(standing.id)).not.toBe('scheduled')
  expect((await post('/api/team/pause')).statusCode).toBe(200)
  expect(await status(standing.id)).toBe('scheduled')
  expect(rows('SELECT task_id, state FROM team_paused_tasks')).toEqual([
    { task_id: standing.id, state: 'held' },
  ])
  expect((await post('/api/team/resume')).statusCode).toBe(200)
  expect(await status(standing.id)).not.toBe('scheduled')
  expect(rows('SELECT 1 FROM team_paused_tasks')).toEqual([])
})

test('a crash during Resume everyone still leaves the team briefs resumed after recovery (gate re-check)', async () => {
  const step = await port.createTask({ title: 'Step', assignee: 'builder', roomId }, 'crash-step')
  const id = MessageSchema.parse((await send({ text: 'Do the crash thing' })).json().message).id
  await link(id, step.id)
  await ingest.flushListeners()
  expect((await post('/api/team/pause')).statusCode).toBe(200)
  expect(await status(step.id)).toBe('scheduled')
  // The server stops right after Resume's first commit: every later write fails.
  const submit = ingest.submit.bind(ingest)
  let writes = 0
  const crash = vi
    .spyOn(ingest, 'submit')
    .mockImplementation((observation) =>
      writes++ === 0 ? submit(observation) : Promise.reject(new Error('stopped')),
    )
  expect((await post('/api/team/resume')).statusCode).toBeGreaterThanOrEqual(500)
  crash.mockRestore()
  expect(rows('SELECT paused_at FROM briefs WHERE id = ?', id)).toEqual([{ paused_at: null }])
  expect(await app.recoverTaskHolds!()).toBe(0)
  expect(await status(step.id)).not.toBe('scheduled')
  expect(rows('SELECT 1 FROM brief_paused_tasks')).toEqual([])
  expect(rows('SELECT 1 FROM team_paused_tasks')).toEqual([])
})
