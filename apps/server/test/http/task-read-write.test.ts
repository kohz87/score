import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TaskDetailSchema, TaskSummarySchema } from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { deriveTaskEvents } from '../../src/domain/tasks.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createScenario } from '../../src/hermes/fake/scenario.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'
import { taskWithApproval } from '../../src/domain/tasks.ts'
import { recordKanbanDenial } from '../../src/domain/kanban-denials.ts'
import { approvalDraft, patchApproval } from '../../src/domain/approval-store.ts'

let home: string
let db: ScoreDb
let ingest: Ingest
let scheduler: FakeScheduler
let port: FakePort
let app: ReturnType<typeof buildApp>
let headers: { cookie: string; 'x-score-client': string }
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'score-tasks-api-'))
  db = openDatabase(join(home, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  ingest = createIngest(db, { deriveEvents: deriveTaskEvents })
  scheduler = new FakeScheduler()
  port = new FakePort(1, { db, scheduler }, false)
  await port.start(ingest)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    clock: () => scheduler.now(),
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  headers = {
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
    'x-score-client': 'web',
  }
})
afterEach(async () => {
  await app.close()
  await port.stop()
  await ingest.close()
  db.close()
  rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

test('fake GET returns the scenario task at the same stream watermark', async () => {
  await scheduler.advance(700 * 18)
  const expected = createScenario(0).find((step) => step.kind === 'task.upserted')!
  const response = await app.inject('/api/tasks')
  expect(response.statusCode).toBe(200)
  const body = response.json()
  const task = TaskSummarySchema.parse(body.columns.working[0])
  expect(task).toMatchObject({
    id: expected.data.id,
    title: 'Add pagination to the activity feed',
    key: 'T-101',
  })
  expect(body.asOfSeq).toBe(db.sqlite.prepare('SELECT MAX(seq) AS seq FROM events').get()!.seq)
  const detail = TaskDetailSchema.parse((await app.inject(`/api/tasks/${task.id}`)).json())
  expect(detail.id).toBe(task.id)
  expect((await app.inject('/api/tasks/unknown')).statusCode).toBe(404)
})

test('filters combine and archived tasks stay out of the board', async () => {
  const create = async (title: string, assignee: string, roomId: string) =>
    TaskDetailSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/tasks',
          headers,
          payload: { title, assignee, roomId },
        })
      ).json(),
    )
  const selected = await create('Selected', 'builder', 'room-one')
  await create('Other', 'reviewer', 'room-two')
  const result = (await app.inject('/api/tasks?room=room-one&agent=builder&column=planned')).json()
  expect(result.columns.planned.map((task: { id: string }) => task.id)).toEqual([selected.id])
  await app.inject({
    method: 'POST',
    url: `/api/tasks/${selected.id}/actions`,
    headers,
    payload: { action: 'block' },
  })
  expect((await app.inject('/api/tasks?needsYou=true')).json().columns.needs_you).toHaveLength(1)
  await app.inject({
    method: 'POST',
    url: `/api/tasks/${selected.id}/actions`,
    headers,
    payload: { action: 'archive' },
  })
  expect((await app.inject('/api/tasks?needsYou=true')).json().columns.needs_you).toHaveLength(0)
  expect(
    (await port.listTasks({ includeArchived: true })).find((task) => task.id === selected.id)
      ?.hermesStatus,
  ).toBe('archived')
  expect((await app.inject('/api/tasks?needsYou=invalid')).statusCode).toBe(400)
})

test('create and patch steps round-trip body, and keyed retries replay without further mutations', async () => {
  const create = vi.spyOn(port, 'createTask')
  const patch = vi.spyOn(port, 'patchTask')
  const request = {
    method: 'POST' as const,
    url: '/api/tasks',
    headers: { ...headers, 'idempotency-key': 'create' },
    payload: {
      title: 'Task',
      body: 'Before\n- [ ] old\nAfter\n',
      steps: ['build', 'test'],
      assignee: 'builder',
    },
  }
  const response = await app.inject(request)
  expect(response.statusCode).toBe(200)
  const task = TaskDetailSchema.parse(response.json())
  expect(task.body).toBe('Before\n- [ ] build\n- [ ] test\nAfter\n')
  expect((await app.inject(request)).json()).toEqual(task)
  expect(create).toHaveBeenCalledTimes(1)
  expect(
    (await app.inject({ ...request, payload: { title: 'conflicting body' } })).statusCode,
  ).toBe(409)
  const edit = {
    method: 'PATCH' as const,
    url: `/api/tasks/${task.id}`,
    headers: { ...headers, 'idempotency-key': 'patch' },
    payload: { steps: task.steps.map((step) => ({ ...step, done: true })) },
  }
  const edited = await app.inject(edit)
  expect(edited.statusCode).toBe(200)
  expect(edited.json().body).toBe('Before\n- [x] build\n- [x] test\nAfter\n')
  expect((await app.inject(edit)).json()).toEqual(edited.json())
  expect(patch).toHaveBeenCalledTimes(1)
})

test.each(['POST', 'PATCH'] as const)(
  '%s task mutations require a human and validate edge input',
  async (method) => {
    const url = method === 'POST' ? '/api/tasks' : '/api/tasks/missing'
    expect(
      (
        await app.inject({
          method,
          url,
          headers: { 'x-score-client': 'web' },
          payload: { title: 'Task' },
        })
      ).statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          method,
          url,
          headers: { cookie: headers.cookie },
          payload: { title: 'Task' },
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (await app.inject({ method, url, headers, payload: { title: 'Task\0' } })).statusCode,
    ).toBe(400)
    expect(
      (
        await app.inject({
          method,
          url,
          headers,
          payload: {
            steps:
              method === 'POST'
                ? ['two\nlines']
                : [{ id: 'step', text: 'two\nlines', done: false }],
          },
        })
      ).statusCode,
    ).toBe(400)
  },
)

test('open visible approvals move any task into Needs you and disappear when closed', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers,
    payload: { title: 'Task' },
  })
  const task = TaskDetailSchema.parse(created.json())
  await ingest.submit({
    source: 'test',
    identity: 'approval',
    apply: ({ sqlite }) =>
      recordKanbanDenial(
        sqlite,
        { taskId: task.id, runId: 1, patternKey: 'delete', commandDigest: 'digest' },
        { profile: 'builder', id: 'test', incarnation: 'test' },
        'Example command',
        new Date(scheduler.now()).toISOString(),
      ),
  })
  const pending = TaskDetailSchema.parse((await app.inject(`/api/tasks/${task.id}`)).json())
  expect(pending.column).toBe('needs_you')
  expect(pending.pendingApproval).toMatchObject({ origin: 'kanban', actionable: false })
  const latest = db.sqlite
    .prepare("SELECT data FROM events WHERE type = 'task.upserted' ORDER BY seq DESC LIMIT 1")
    .get()!
  expect(JSON.parse(latest.data as string)).toMatchObject({ id: task.id, column: 'needs_you' })
  expect((await app.inject('/api/tasks?needsYou=true')).json().columns.needs_you).toHaveLength(1)
  await ingest.submit({
    source: 'test',
    identity: 'approval-closed',
    apply: ({ sqlite, now }) => {
      patchApproval(
        sqlite,
        pending.pendingApproval!.id,
        { closed_reason: 'task_moved', closed_at: now },
        now,
      )
      return approvalDraft(sqlite, pending.pendingApproval!.id)
    },
  })
  expect(
    db.read((sqlite) => taskWithApproval(sqlite, task, scheduler.now())).pendingApproval,
  ).toBeNull()
  expect((await app.inject('/api/tasks?needsYou=true')).json().columns.needs_you).toHaveLength(0)
})

test('a keyed task detail larger than 64 KB is persisted and replayed', async () => {
  const create = vi.spyOn(port, 'createTask')
  const request = {
    method: 'POST' as const,
    url: '/api/tasks',
    headers: { ...headers, 'idempotency-key': 'large-task' },
    payload: { title: 'Large task', body: '€'.repeat(32000) },
  }
  const first = await app.inject(request)
  expect(first.statusCode).toBe(200)
  expect(Buffer.byteLength(first.body)).toBeGreaterThan(65536)
  expect((await app.inject(request)).body).toBe(first.body)
  expect(create).toHaveBeenCalledTimes(1)
})
