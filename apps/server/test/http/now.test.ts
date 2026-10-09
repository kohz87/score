import { NowSnapshotSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { createHermesPort, type HermesPort } from '../../src/hermes/index.ts'
import { projectTask, readProjectedTask } from '../../src/domain/tasks.ts'
import { insertRoom, storeMessage } from '../../src/domain/rooms.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { scenarioDuration } from '../../src/hermes/fake/scenario.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: HermesPort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-now-'))
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
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})
const get = (url = '/api/now') => app.inject({ method: 'GET', url })

test('an idle team still returns a lane per agent and a quiet headline', async () => {
  const response = await get()
  expect(response.statusCode).toBe(200)
  const now = NowSnapshotSchema.parse(response.json())
  expect(now.lanes.map((lane) => lane.agent.id)).toEqual([
    'lead',
    'builder',
    'reviewer',
    'designer',
  ])
  expect(now.lanes.every((lane) => lane.blocks.length === 0)).toBe(true)
  expect(now.handoffs).toEqual([])
  expect(now.headline).toEqual({
    working: 0,
    needsYou: 0,
    text: 'Nobody is working. Nothing needs you.',
  })
  expect(now.focusApproval).toBeNull()
  expect(now.thread).toBeNull()
  expect(now.madeToday).toEqual([])
})

test('fake scenario mid-run gives working lanes, an approval and the latest thread', async () => {
  await port.start(ingest)
  await scheduler.advance(45_000)
  const now = NowSnapshotSchema.parse((await get()).json())
  const builder = now.lanes.find((lane) => lane.agent.id === 'builder')!
  expect(builder.blocks.some((block) => block.state === 'working' && block.taskId !== null)).toBe(
    true,
  )
  expect(builder.blocks.some((block) => block.label === 'Waiting on you')).toBe(true)
  expect(now.headline.working).toBeGreaterThanOrEqual(1)
  expect(now.headline.needsYou).toBeGreaterThanOrEqual(1)
  expect(now.headline.text).toMatch(/working\. .* need/)
  expect(now.focusApproval?.actionable).toBe(true)
  expect(now.thread?.roomId).toBe('room-activity-feed')
  expect(now.thread!.messages.length).toBeLessThanOrEqual(3)
})

test('finished fake scenario lists the task under made today with its review run', async () => {
  await port.start(ingest)
  await scheduler.advance(scenarioDuration)
  const now = NowSnapshotSchema.parse((await get()).json())
  // The brief's review step (3.4) is its own task and finishes too.
  expect(now.madeToday.map((item) => item.title).sort()).toEqual([
    'Add pagination to the activity feed',
    'Review pagination',
  ])
  expect(now.madeToday.map((item) => item.ref)).toContainEqual({
    kind: 'task',
    taskId: 'task-pagination-0',
  })
  const reviewer = now.lanes.find((lane) => lane.agent.id === 'reviewer')!
  expect(reviewer.blocks.length).toBeGreaterThan(0)
})

test('made today uses the completion time, not later activity such as comments', async () => {
  await port.start(ingest)
  await scheduler.advance(scenarioDuration)
  const task = readProjectedTask(db.sqlite, 'task-pagination-0')!
  const yesterday = new Date(scheduler.now() - 30 * 3_600_000).toISOString()
  db.tx((sqlite) => {
    projectTask(
      sqlite,
      { ...task, completedAt: yesterday, updatedAt: new Date(scheduler.now()).toISOString() },
      1_000_000,
    )
  })
  const now = NowSnapshotSchema.parse((await get()).json())
  expect(now.madeToday.map((item) => item.ref)).not.toContainEqual({
    kind: 'task',
    taskId: 'task-pagination-0',
  })
})

test('a narrow window returns only what overlaps it', async () => {
  await port.start(ingest)
  await scheduler.advance(scenarioDuration)
  const far = new Date(scheduler.now() - 48 * 3_600_000)
  const url = `/api/now?from=${far.toISOString()}&to=${new Date(far.getTime() + 3_600_000).toISOString()}`
  const now = NowSnapshotSchema.parse((await get(url)).json())
  expect(now.lanes.flatMap((lane) => lane.blocks)).toEqual([])
})

test.each([
  '/api/now?from=nonsense',
  '/api/now?from=2026-01-01T12:00:00.000Z&to=2026-01-01T11:00:00.000Z',
  '/api/now?from=2026-01-01T12:00:00.000Z&to=2026-01-01T12:00:00.000Z',
  '/api/now?from=2026-01-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z',
  '/api/now?extra=1',
])('invalid window %s is a 400', async (url) => {
  const response = await get(url)
  expect(response.statusCode).toBe(400)
  expect(response.json().error.code).toBe('bad_request')
})

test('a completed reviewer run that was followed by more work is not a passed review', async () => {
  await port.start(ingest)
  await scheduler.advance(scenarioDuration)
  const task = readProjectedTask(db.sqlite, 'task-pagination-0')!
  const at = (minutes: number) => new Date(scheduler.now() - minutes * 60_000).toISOString()
  const insert = db.sqlite.prepare(
    `INSERT INTO runs (id, profile, origin, status, started_at, ended_at, updated_at)
     VALUES (?, ?, 'kanban', 'completed', ?, ?, ?)`,
  )
  const rows: [string, string, number][] = [
    ['chk-r1', 'reviewer', 30],
    ['chk-b2', 'builder', 20],
    ['chk-r2', 'reviewer', 10],
  ]
  for (const [id, profile, ago] of rows) insert.run(id, profile, at(ago), at(ago - 5), at(ago - 5))
  db.tx((sqlite) => {
    projectTask(
      sqlite,
      {
        ...task,
        reviewer: 'reviewer',
        runIds: ['chk-r1', 'chk-b2', 'chk-r2'],
        completedAt: at(1),
      },
      1_000_001,
    )
  })
  const now = NowSnapshotSchema.parse((await get()).json())
  const item = now.madeToday.find(
    (entry) => entry.ref.kind === 'task' && entry.ref.taskId === task.id,
  )!
  expect(item.checks.map((check) => check.verdict)).toEqual(['unknown', 'passed'])
})

test('lanes tell plain chat replies from brief work and tasks; chat replies merge into a band', async () => {
  await port.start(ingest)
  const agents = await port.listAgents()
  const id = agents[0]!.id
  const nowMs = scheduler.now()
  const at = (minutes: number) => new Date(nowMs - minutes * 60_000).toISOString()
  db.tx((sqlite) => {
    insertRoom(
      sqlite,
      { id: 'r', name: '#kind-test', kind: 'room', leadAgentId: id, members: [id] },
      at(60),
    )
    for (const key of ['m1', 'm2', 'm3'])
      storeMessage(
        sqlite,
        {
          id: key,
          roomId: 'r',
          author: { kind: 'you' },
          to: [],
          parts: [{ kind: 'text', text: key }],
          createdAt: at(50),
          streaming: false,
          refs: [],
        },
        at(50),
      )
    const run = sqlite.prepare(
      `INSERT INTO runs (id, profile, origin, status, started_at, ended_at, updated_at)
       VALUES (?, ?, 'score', 'completed', ?, ?, ?)`,
    )
    const turn = sqlite.prepare(
      `INSERT INTO message_runs (message_id, run_id, room_id, agent_id, chain_id, hop, turn_id, parent_message_id, input, agents, state, created_at, plan_first)
       VALUES (?, ?, 'r', ?, ?, 0, ?, ?, 'x', '[]', 'completed', ?, ?)`,
    )
    // Two chat replies 3 minutes apart (one band) and one brief that planned first.
    run.run('chat-1', id, at(30), at(28), at(28))
    run.run('chat-2', id, at(25), at(24), at(24))
    run.run('plan-1', id, at(15), at(12), at(12))
    turn.run('a1', 'chat-1', id, 'm1', 't1', 'm1', at(30), 0)
    turn.run('a2', 'chat-2', id, 'm2', 't2', 'm2', at(25), 0)
    turn.run('a3', 'plan-1', id, 'm3', 't3', 'm3', at(15), 1)
  })
  const now = NowSnapshotSchema.parse((await get()).json())
  const blocks = now.lanes.find((lane) => lane.agent.id === id)!.blocks
  expect(blocks.map((block) => [block.id, block.kind, block.count])).toEqual([
    ['chat:chat-1', 'chat', 2],
    ['run:plan-1', 'brief', undefined],
  ])
})
