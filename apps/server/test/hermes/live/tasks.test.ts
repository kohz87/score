import { join } from 'node:path'
import { renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TaskDetailSchema } from '@score/contract'
import { migrate, openDatabase, type ScoreDb } from '../../../src/db/index.ts'
import { parseSteps } from '../../../src/domain/steps.ts'
import { projectedTasks, readProjectedTask } from '../../../src/domain/tasks.ts'
import { createIngest, type Ingest } from '../../../src/hub/ingest.ts'
import { readTaskDetails, taskColumn } from '../../../src/hermes/live/task-model.ts'
import { createTask, patchTask } from '../../../src/hermes/live/task-writes.ts'
import { LiveTasks } from '../../../src/hermes/live/tasks.ts'
import { createFixtureHome, insertTask } from '../../fixtures/hermes/sqlite-fixture.ts'

let fixture: ReturnType<typeof createFixtureHome>
let score: ScoreDb
let ingest: Ingest
let upstream: ReturnType<typeof fixture.build>
let tasks: LiveTasks
beforeEach(() => {
  fixture = createFixtureHome()
  upstream = fixture.build('kanban')
  score = openDatabase(join(fixture.home, 'score.db'))
  migrate(score, fileURLToPath(new URL('../../../migrations/', import.meta.url)))
  ingest = createIngest(score)
  tasks = new LiveTasks(score, ingest, fixture.home)
  insertTask(upstream.db, 't_test')
})
afterEach(async () => {
  await tasks.close()
  await ingest.close()
  score.close()
  fixture.close()
})

test.each([
  ['triage', 'planned'],
  ['todo', 'planned'],
  ['scheduled', 'planned'],
  ['ready', 'planned'],
  ['running', 'working'],
  ['review', 'in_review'],
  ['blocked', 'needs_you'],
  ['done', 'done'],
  ['archived', null],
])('maps %s to %s', (status, column) => {
  expect(taskColumn(status)).toBe(column)
})
test('unknown upstream statuses fail visibly', () => {
  expect(() => taskColumn('new-upstream-status')).toThrow('task status Score doesn’t know')
})

test.each(['dependency', 'needs_input', 'capability', 'transient', null])(
  'blocked %s needs a human with the right badge',
  (kind) => {
    upstream.db.prepare("UPDATE tasks SET status = 'blocked', block_kind = ?").run(kind)
    expect(readTaskDetails(upstream.db)[0]).toMatchObject({
      column: 'needs_you',
      badge: { kind: ['needs_input', 'capability'].includes(kind ?? '') ? 'needs_you' : 'blocked' },
    })
  },
)

test('fixture reader maps rowid, both links, steps, runs and newest 50 activities', () => {
  insertTask(upstream.db, 't_parent')
  insertTask(upstream.db, 't_child')
  upstream.db
    .exec(`UPDATE tasks SET status = 'running', body = 'Intro\n- [x] build\n- [ ] test\nEnd', started_at = 2000 WHERE id = 't_test';
    INSERT INTO task_links (parent_id, child_id) VALUES ('t_parent', 't_test'), ('t_test', 't_child');
    INSERT INTO task_runs (task_id, profile, status, started_at) VALUES ('t_test', 'builder', 'running', 2000);`)
  for (let index = 0; index < 60; index++)
    upstream.db
      .prepare(
        "INSERT INTO task_comments (task_id, author, body, created_at) VALUES ('t_test', 'score', ?, ?)",
      )
      .run(`Comment ${index}`, 2000 + index)
  const task = TaskDetailSchema.parse(readTaskDetails(upstream.db, 2060 * 1000)[0])
  expect(task).toMatchObject({
    id: 't_test',
    key: 'T-1',
    progress: 0.5,
    elapsedSec: 60,
    dependsOn: ['t_parent'],
    blocks: ['t_child'],
    runIds: ['1'],
    body: 'Intro\n- [x] build\n- [ ] test\nEnd',
  })
  expect(task.activity).toHaveLength(50)
  expect(task.activity[0]).toMatchObject({ text: 'Comment 59', agentId: 'you' })
  upstream.db.prepare("UPDATE tasks SET status = 'review' WHERE id = 't_test'").run()
  expect(readTaskDetails(upstream.db)[0]!.progress).toBeNull()
})

test('tailer commits projections, event identities and checkpoints; restart never repeats activity', async () => {
  upstream.db.exec(
    "INSERT INTO task_events (task_id, kind, payload, created_at) VALUES ('t_test', 'created', NULL, 2000), ('t_test', 'comment', '{\"text\":\"token=example-secret\",\"author\":\"score\"}', 2001)",
  )
  await tasks.poll()
  expect(projectedTasks(score.sqlite)[0]).toMatchObject({ key: 'T-1' })
  const events = score.sqlite.prepare('SELECT type, data FROM events ORDER BY seq').all()
  expect(events.map((event) => event.type)).toEqual([
    'task.upserted',
    'task.activity',
    'task.upserted',
    'task.activity',
  ])
  expect(JSON.stringify(events)).not.toContain('example-secret')
  expect(
    score.sqlite
      .prepare(
        "SELECT identity FROM ingest_keys WHERE identity LIKE 'kanban-event:%' ORDER BY identity",
      )
      .all(),
  ).toEqual([{ identity: 'kanban-event:1' }, { identity: 'kanban-event:2' }])
  await tasks.close()
  tasks = new LiveTasks(score, ingest, fixture.home)
  await tasks.poll()
  expect(score.sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 4 })
  upstream.db.exec("UPDATE tasks SET title = 'Changed without event' WHERE id = 't_test'")
  await tasks.poll()
  expect(readProjectedTask(score.sqlite, 't_test')!.title).toBe('Changed without event')
})

function writeDeps(runner: NonNullable<Parameters<typeof createTask>[2]['runner']>) {
  return {
    runner,
    db: score,
    hermesHome: fixture.home,
    getTask: async (id: string) => {
      await tasks.poll()
      const task = readProjectedTask(score.sqlite, id)
      if (!task) throw Object.assign(new Error('Unknown task'), { status: 404 })
      return task
    },
  }
}

test('create uses exact safe argv, steps and parent flags, then rereads and deduplicates its intent', async () => {
  const runner = vi.fn(async () => {
    insertTask(upstream.db, 't_created')
    upstream.db
      .prepare("UPDATE tasks SET title = ?, body = ? WHERE id = 't_created'")
      .run('--help $(never)', 'Opening\n- [ ] build')
    return { exitCode: 0, stdout: '{"id":"t_created"}' }
  })
  const req = {
    title: '--help $(never)',
    body: 'Opening',
    assignee: 'builder',
    dependsOn: ['t_test'],
    steps: ['build'],
  }
  const task = await createTask(req, 'create-key', writeDeps(runner))
  expect(task.id).toBe('t_created')
  expect(task.steps).toEqual(parseSteps('Opening\n- [ ] build'))
  expect(runner).toHaveBeenCalledExactlyOnceWith(
    [
      'kanban',
      'create',
      '--json',
      '--idempotency-key=create-key',
      '--created-by',
      'score',
      '--body=Opening\n- [ ] build',
      '--assignee=builder',
      '--parent=t_test',
      '--',
      '--help $(never)',
    ],
    { timeoutMs: 10000, captureTaskCreate: true, hermesHome: fixture.home },
  )
  expect((await createTask(req, 'create-key', writeDeps(runner))).id).toBe(task.id)
  expect(runner).toHaveBeenCalledTimes(1)
})

test('patch title, body, steps and assignee uses exact separate verbs and rereads', async () => {
  upstream.db.exec("UPDATE tasks SET body = 'Before\n- [ ] old\nAfter' WHERE id = 't_test'")
  const runner = vi.fn(async (args: string[]) => {
    if (args[1] === 'edit')
      upstream.db
        .prepare('UPDATE tasks SET title = ?, body = ?')
        .run('--new', 'Before\n- [x] done\nAfter')
    if (args[1] === 'assign') upstream.db.exec("UPDATE tasks SET assignee = 'reviewer'")
    return { exitCode: 0 }
  })
  const task = await patchTask(
    't_test',
    { title: '--new', assignee: 'reviewer', steps: [{ id: 'step', text: 'done', done: true }] },
    writeDeps(runner),
  )
  expect(task).toMatchObject({
    title: '--new',
    assignee: 'reviewer',
    body: 'Before\n- [x] done\nAfter',
  })
  expect(runner.mock.calls.map(([args]) => args)).toEqual([
    ['kanban', 'edit', '--title=--new', '--body=Before\n- [x] done\nAfter', '--', 't_test'],
    ['kanban', 'assign', '--', 't_test', 'reviewer'],
  ])
})

test('unsupported create/patch fields return 501 before any command; missing patch returns 404', async () => {
  const runner = vi.fn(async () => ({ exitCode: 0 }))
  const deps = writeDeps(runner)
  await expect(
    createTask({ title: 'Task', reviewer: 'reviewer' }, 'reviewer-key', deps),
  ).rejects.toMatchObject({ status: 501 })
  await expect(
    createTask({ title: 'Task', roomId: 'no-such-room' }, 'room-key', deps),
  ).rejects.toMatchObject({ status: 400 })
  await expect(
    patchTask('t_test', { title: 'ignored', reviewer: 'reviewer' }, deps),
  ).rejects.toMatchObject({ status: 501 })
  await expect(patchTask('t_missing', { title: 'missing' }, deps)).rejects.toMatchObject({
    status: 404,
  })
  expect(runner).not.toHaveBeenCalled()
})

test.each([1, -1])('mutation exit %s returns the appropriate error', async (exitCode) => {
  const deps = writeDeps(vi.fn(async () => ({ exitCode })))
  await expect(createTask({ title: 'Task' }, 'fail-create', deps)).rejects.toMatchObject({
    status: exitCode < 0 ? 502 : 409,
  })
  await expect(patchTask('t_test', { title: 'Task' }, deps)).rejects.toMatchObject({
    status: exitCode < 0 ? 502 : 409,
  })
})

test('an uncertain create is retried with the same Hermes idempotency key, never as a new task', async () => {
  let created = false
  const runner = vi.fn(async (args: string[]) => {
    // First call: Hermes made the task but the answer was lost. Second call: Hermes returns it again.
    const first = !created && args.includes('create')
    if (first) insertTask(upstream.db, 't_once')
    created = true
    return first
      ? { exitCode: 0, stdout: 'invalid output' }
      : { exitCode: 0, stdout: '{"id":"t_once"}' }
  })
  const deps = writeDeps(runner)
  await expect(createTask({ title: 'Task' }, 'uncertain-create', deps)).rejects.toMatchObject({
    status: 502,
  })
  await expect(createTask({ title: 'Task' }, 'uncertain-create', deps)).resolves.toMatchObject({
    id: 't_once',
  })
  expect(runner).toHaveBeenCalledTimes(2)
  const keys = runner.mock.calls.map(([args]) =>
    args.find((a) => a.startsWith('--idempotency-key')),
  )
  expect(keys).toEqual(['--idempotency-key=uncertain-create', '--idempotency-key=uncertain-create'])
  expect(
    score.sqlite
      .prepare("SELECT state, result FROM command_intents WHERE kind = 'task-create'")
      .all(),
  ).toEqual([{ state: 'accepted', result: 't_once' }])
  // A different body under the same key is still refused.
  await expect(createTask({ title: 'Other' }, 'uncertain-create', deps)).rejects.toMatchObject({
    status: 409,
  })
})

test('a task created from a room carries that room in the live projection', async () => {
  score.sqlite
    .prepare(
      "INSERT INTO rooms (id, name, kind, members, created_at, updated_at) VALUES ('room-1', 'Room', 'room', '[]', 'now', 'now')",
    )
    .run()
  const runner = vi.fn(async () => {
    insertTask(upstream.db, 't_room')
    return { exitCode: 0, stdout: '{"id":"t_room"}' }
  })
  const task = await createTask(
    { title: 'In a room', roomId: 'room-1' },
    'room-ok',
    writeDeps(runner),
  )
  expect(task.roomId).toBe('room-1')
  await tasks.poll()
  expect(projectedTasks(score.sqlite).find((item) => item.id === 't_room')?.roomId).toBe('room-1')
  expect(projectedTasks(score.sqlite).find((item) => item.id === 't_test')?.roomId).toBeNull()
  // Room is Score's: the Hermes command line never mentions it.
  expect(JSON.stringify(runner.mock.calls)).not.toContain('room-1')
})

test('replacement database resets event identities and removes tasks no longer present', async () => {
  upstream.db.exec(
    "INSERT INTO task_events (task_id, kind, payload, created_at) VALUES ('t_test', 'created', NULL, 2000)",
  )
  await tasks.poll()
  const replacement = fixture.build('kanban', 'replacement.db')
  insertTask(replacement.db, 't_replacement')
  replacement.db.exec(
    "INSERT INTO task_events (task_id, kind, payload, created_at) VALUES ('t_replacement', 'created', NULL, 1000)",
  )
  replacement.db.close()
  upstream.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  upstream.db.close()
  renameSync(replacement.path, upstream.path)
  await tasks.poll()
  expect(readProjectedTask(score.sqlite, 't_test')).toBeUndefined()
  expect(readProjectedTask(score.sqlite, 't_replacement')).toMatchObject({
    id: 't_replacement',
    key: 'T-1',
  })
  expect(
    score.sqlite
      .prepare("SELECT COUNT(*) AS n FROM ingest_keys WHERE identity = 'kanban-event:1'")
      .get(),
  ).toEqual({ n: 2 })
})

test('toggling steps preserves original body bytes even when the read model redacts them', async () => {
  const body = 'Before token=example-secret\r\n * [ ] password=step-secret\r\nAfter\r\n'
  upstream.db.prepare("UPDATE tasks SET body = ? WHERE id = 't_test'").run(body)
  const detail = readTaskDetails(upstream.db)[0]!
  expect(detail.body).not.toContain('example-secret')
  const runner = vi.fn(async () => ({ exitCode: 0 }))
  await patchTask(
    't_test',
    { steps: detail.steps.map((step) => ({ ...step, done: true })) },
    writeDeps(runner),
  )
  expect(runner).toHaveBeenCalledExactlyOnceWith(
    [
      'kanban',
      'edit',
      '--body=Before token=example-secret\r\n * [x] password=step-secret\r\nAfter\r\n',
      '--',
      't_test',
    ],
    { timeoutMs: 10000, hermesHome: fixture.home },
  )
})

test('brief review and sent-back edges survive late links and deduplicate on restart', async () => {
  const { createBrief, linkTask } = await import('../../../src/domain/briefs.ts')
  const { insertRoom, storeMessage } = await import('../../../src/domain/rooms.ts')
  upstream.db.exec(`UPDATE tasks SET assignee = 'builder', status = 'running' WHERE id = 't_test';
    INSERT INTO task_events (task_id, kind, payload, created_at) VALUES
    ('t_test', 'review_requested', '{"reviewer":"reviewer","reason":"Custom feedback"}', 2100),
    ('t_test', 'changes_requested', '{"author":"reviewer","reason":"Use a composite cursor"}', 2200);`)
  // More than the 50-event activity window of later events must not hide the older review events.
  const pad = upstream.db.prepare(
    "INSERT INTO task_events (task_id, kind, payload, created_at) VALUES ('t_test', 'edited', NULL, ?)",
  )
  for (let index = 0; index < 60; index += 1) pad.run(2201 + index)
  await tasks.poll()
  await ingest.submit({
    source: 'test',
    identity: 'brief',
    apply({ sqlite, now }) {
      insertRoom(
        sqlite,
        {
          id: 'room-flow',
          name: 'Flow',
          kind: 'room',
          leadAgentId: 'lead',
          members: ['lead', 'builder', 'reviewer'],
        },
        now,
      )
      storeMessage(
        sqlite,
        {
          id: 'brief-flow',
          roomId: 'room-flow',
          author: { kind: 'you' },
          to: ['lead'],
          parts: [{ kind: 'text', text: 'Review the cursor' }],
          createdAt: now,
          streaming: false,
          refs: [],
        },
        now,
      )
      const drafts = createBrief(
        sqlite,
        {
          id: 'brief-flow',
          roomId: 'room-flow',
          text: 'Review the cursor',
          startedAt: new Date(2000 * 1000).toISOString(),
        },
        now,
      )
      linkTask(sqlite, 'brief-flow', 't_test', 'plan', now)
      return drafts
    },
  })
  await tasks.poll()
  const before = score.sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()
  await tasks.close()
  tasks = new LiveTasks(score, ingest, fixture.home)
  await tasks.poll()
  expect(score.sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual(before)
  expect(score.sqlite.prepare('SELECT COUNT(*) AS n FROM brief_edges').get()).toEqual({ n: 2 })
})

test('the reviewer is the newest review event, read from its reviewer field even past the activity window', () => {
  const event = (kind: string, payload: object, at: number) =>
    upstream.db
      .prepare(
        "INSERT INTO task_events (task_id, kind, payload, created_at) VALUES ('t_test', ?, ?, ?)",
      )
      .run(kind, JSON.stringify(payload), at)
  event('review_requested', { implementer: 'builder', reviewer: 'reviewer' }, 3000)
  event('changes_requested', { implementer: 'builder', reviewer: 'reviewer' }, 3001)
  event('review_requested', { implementer: 'builder', reviewer: 'designer' }, 3002)
  expect(readTaskDetails(upstream.db).find((task) => task.id === 't_test')?.reviewer).toBe(
    'designer',
  )
  // 60 later events push every review event out of the 50-item activity window.
  for (let at = 4000; at < 4060; at++) event('heartbeat', {}, at)
  expect(readTaskDetails(upstream.db).find((task) => task.id === 't_test')?.reviewer).toBe(
    'designer',
  )
  event('changes_requested', { implementer: 'builder', reviewer: 'lead' }, 5000)
  expect(readTaskDetails(upstream.db).find((task) => task.id === 't_test')?.reviewer).toBe('lead')
})

test('concurrent creates with one key reach the CLI once and share the task', async () => {
  const runner = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    insertTask(upstream.db, 't_once')
    return { exitCode: 0, stdout: '{"id":"t_once"}' }
  })
  const [a, b] = await Promise.all([
    createTask({ title: 'Once' }, 'race-key', writeDeps(runner)),
    createTask({ title: 'Once' }, 'race-key', writeDeps(runner)),
  ])
  expect([a.id, b.id]).toEqual(['t_once', 't_once'])
  expect(runner).toHaveBeenCalledTimes(1)
})
