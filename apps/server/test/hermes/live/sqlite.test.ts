import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ZodError } from 'zod'
import {
  closeReadOnly,
  createTailer,
  HermesDbMissing,
  HermesSchemaDrift,
  hermesPaths,
  incarnationOf,
  openReadOnly,
  readSessions,
  readTaskComments,
  readTaskLinks,
  readTaskRuns,
  readTasks,
  tailMessages,
  tailTaskEvents,
  type ReaderBatch,
} from '../../../src/hermes/live/index.ts'
import {
  createFixtureHome,
  insertEvent,
  insertMessage,
  insertSession,
  insertTask,
} from '../../fixtures/hermes/sqlite-fixture.ts'

let fixtures: ReturnType<typeof createFixtureHome>
const readers: DatabaseSync[] = []
const tailers: { close(): void }[] = []

beforeEach(() => {
  fixtures = createFixtureHome()
})

afterEach(() => {
  for (const tailer of tailers.splice(0)) tailer.close()
  for (const reader of readers.splice(0)) {
    if (reader.isOpen) closeReadOnly(reader)
  }
  fixtures.close()
})

function open(path: string) {
  const reader = openReadOnly(path)
  readers.push(reader)
  return reader
}

const sources = [
  { kind: 'kanban', seed: insertTask, insert: insertEvent, read: tailTaskEvents },
  { kind: 'state', seed: insertSession, insert: insertMessage, read: tailMessages },
] as const

function setup(source: (typeof sources)[number], limit = 500) {
  const fixture = fixtures.build(source.kind)
  source.seed(fixture.db)
  const tailer = createTailer({
    path: fixture.path,
    scope: source.kind === 'kanban' ? 'tasks' : 'builder',
    limit,
    read: (db, afterId, limit): ReaderBatch<{ id: number }> => source.read(db, { afterId, limit }),
    idOf: (row) => row.id,
  })
  tailers.push(tailer)
  return { ...fixture, tailer }
}

test.each(sources)(
  '$kind tails carried timestamps and same-millisecond rows by ID exactly once',
  (source) => {
    const { db, tailer } = setup(source, 2)
    source.insert(db, 3000)
    const first = tailer.poll()
    expect(first.rows.map((row) => row.id)).toEqual([1])
    source.insert(db, 1000)
    source.insert(db, 1000)
    source.insert(db, 500)
    const second = tailer.poll(first.checkpoint)
    expect(second.rows.map((row) => row.id)).toEqual([2, 3])
    source.insert(db, 1000)
    const third = tailer.poll(second.checkpoint)
    expect(third.rows.map((row) => row.id)).toEqual([4, 5])
    expect(third.checkpoint.position).toBe(5)
    expect(third.checkpoint.resetIncarnation).toBe(false)
    const empty = tailer.poll(third.checkpoint)
    expect(empty.rows).toEqual([])
    expect(empty.checkpoint).toEqual(third.checkpoint)
  },
)

test.each(sources)('$kind reopens and re-baselines after atomic database replacement', (source) => {
  const { db, path, tailer } = setup(source)
  source.insert(db)
  source.insert(db)
  const first = tailer.poll()
  const replacement = fixtures.build(source.kind, 'replacement.db')
  source.seed(replacement.db)
  source.insert(replacement.db, 100)
  replacement.db.close()
  // A valid WAL restore flushes the old sidecar before replacing just the main file.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
  renameSync(replacement.path, path)
  expect(incarnationOf(path)).not.toBe(first.checkpoint.incarnation)
  const reset = tailer.poll(first.checkpoint)
  expect(reset.rows.map((row) => row.id)).toEqual([1])
  expect(reset.checkpoint).toMatchObject({ position: 1, resetIncarnation: true })
  expect(reset.checkpoint.incarnation).toBe(incarnationOf(path))
  expect(tailer.poll(reset.checkpoint)).toMatchObject({
    rows: [],
    checkpoint: { resetIncarnation: false },
  })
})

test.each(sources)(
  '$kind resets a persisted checkpoint on the first poll of a new tailer',
  (source) => {
    const { db, tailer } = setup(source)
    source.insert(db)
    expect(tailer.poll({ position: 900, incarnation: 'old-file' })).toMatchObject({
      rows: [{ id: 1 }],
      checkpoint: { position: 1, resetIncarnation: true },
    })
  },
)

test.each(sources)(
  '$kind leaves file mtime, size and incarnation unchanged on polling',
  (source) => {
    const { db, path, tailer } = setup(source)
    source.insert(db)
    db.close()
    const before = statSync(path)
    const incarnation = incarnationOf(path)
    const first = tailer.poll()
    tailer.poll(first.checkpoint)
    tailer.close()
    const after = statSync(path)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
    expect(incarnationOf(path)).toBe(incarnation)
  },
)

test.each(sources)('$kind connection rejects writes even if query_only is disabled', (source) => {
  const { db, path } = fixtures.build(source.kind)
  db.close()
  const reader = open(path)
  expect(reader.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 })
  expect(reader.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 2000 })
  expect(() => reader.exec('CREATE TABLE forbidden (id INTEGER)')).toThrow(/readonly/i)
  reader.exec('PRAGMA query_only = 0')
  expect(() => reader.exec('CREATE TABLE forbidden (id INTEGER)')).toThrow(/readonly/i)
})

test('missing database is typed and is never created', () => {
  const path = join(fixtures.home, 'missing.db')
  expect(() => openReadOnly(path)).toThrow(HermesDbMissing)
  expect(() => incarnationOf(path)).toThrow(HermesDbMissing)
  expect(existsSync(path)).toBe(false)
})

test('tailer opens lazily, keeps its connection, and reports missing without consuming the checkpoint', () => {
  const path = join(fixtures.home, 'kanban.db')
  const read = vi.fn((db: DatabaseSync, afterId: number, limit: number) =>
    tailTaskEvents(db, { afterId, limit }),
  )
  const tailer = createTailer({ path, scope: 'tasks', read, idOf: (row) => row.id })
  tailers.push(tailer)
  expect(read).not.toHaveBeenCalled()
  const missing = tailer.poll({ position: 50, incarnation: 'old-file' })
  expect(missing).toMatchObject({
    rows: [],
    missing: true,
    checkpoint: { position: 50, incarnation: 'old-file' },
  })
  const fixture = fixtures.build('kanban')
  insertEvent(fixture.db)
  const first = tailer.poll(missing.checkpoint)
  expect(first).toMatchObject({ rows: [{ id: 1 }], checkpoint: { resetIncarnation: true } })
  tailer.poll(first.checkpoint)
  expect(read.mock.calls[0]?.[0]).toBe(read.mock.calls[1]?.[0])
  expect(read.mock.calls[0]?.slice(1)).toEqual([0, 500])
  fixture.db.close()
  unlinkSync(path)
  expect(tailer.poll(first.checkpoint)).toMatchObject({ rows: [], missing: true })
  tailer.close()
  expect(() => tailer.poll()).toThrow('closed')
})

test('empty replacement still returns an incarnation reset with position zero', () => {
  const { tailer } = setup(sources[0])
  expect(tailer.poll({ position: 8, incarnation: 'old-file' })).toMatchObject({
    rows: [],
    checkpoint: { position: 0, resetIncarnation: true },
  })
})

test('paths select the default and named profiles', () => {
  const paths = hermesPaths(fixtures.home)
  expect(paths.kanbanDb).toBe(join(fixtures.home, 'kanban.db'))
  expect(paths.stateDb('default')).toBe(join(fixtures.home, 'state.db'))
  expect(paths.stateDb('builder')).toBe(join(fixtures.home, 'profiles/builder/state.db'))
  expect(paths.stateDb('a'.repeat(64))).toBe(
    join(fixtures.home, 'profiles', 'a'.repeat(64), 'state.db'),
  )
})

test.each([
  '',
  '..',
  '../builder',
  '/tmp/builder',
  'a/b',
  'a\\b',
  'Builder',
  '_builder',
  '-builder',
  'a'.repeat(65),
  'builder\n',
])('rejects invalid profile name %j', (profile) => {
  expect(() => hermesPaths(fixtures.home).stateDb(profile)).toThrow(ZodError)
})

test.each(sources)(
  '$kind parses JSON, preserves null, and returns malformed JSON with a metric',
  (source) => {
    const { db, path } = fixtures.build(source.kind)
    source.seed(db)
    for (const payload of ['{"name":"example"}', null, '{bad json', '[1,true,"text"]', '42']) {
      source.insert(db, 2000, payload)
    }
    const batch = source.read(open(path), { afterId: 0, limit: 20 })
    expect(batch.malformed).toBe(1)
    expect(batch.rows.map((row) => ('payload' in row ? row.payload : row.tool_calls))).toEqual([
      { name: 'example' },
      null,
      { unparsed: '{bad json' },
      [1, true, 'text'],
      42,
    ])
  },
)

test.each(sources)(
  '$kind skips malformed scalar rows, counts them and advances past their IDs',
  (source) => {
    const { db, tailer } = setup(source, 1)
    const timestamp = source.kind === 'kanban' ? 'created_at' : 'timestamp'
    const table = source.kind === 'kanban' ? 'task_events' : 'messages'
    source.insert(db)
    db.exec(`UPDATE ${table} SET ${timestamp} = 'invalid'`)
    source.insert(db)
    const first = tailer.poll()
    expect(first).toMatchObject({ rows: [], malformed: 1, checkpoint: { position: 1 } })
    const second = tailer.poll(first.checkpoint)
    expect(second).toMatchObject({ rows: [{ id: 2 }], malformed: 0, checkpoint: { position: 2 } })
    expect(tailer.poll(second.checkpoint).rows).toEqual([])
  },
)

test.each([
  {
    kind: 'kanban',
    table: 'task_events',
    column: 'payload',
    read: (db: DatabaseSync) => tailTaskEvents(db, { afterId: 0, limit: 10 }),
  },
  {
    kind: 'state',
    table: 'messages',
    column: 'tool_call_uid',
    read: (db: DatabaseSync) => tailMessages(db, { afterId: 0, limit: 10 }),
  },
  {
    kind: 'kanban',
    table: 'tasks',
    column: 'block_kind',
    read: (db: DatabaseSync) => readTasks(db, ['task-1']),
  },
  {
    kind: 'state',
    table: 'sessions',
    column: 'profile_name',
    read: (db: DatabaseSync) => readSessions(db, ['session-1']),
  },
] as const)(
  '$table reports missing $column as a typed schema drift even with no rows',
  ({ kind, table, column, read }) => {
    const { db, path } = fixtures.build(kind)
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    try {
      read(open(path))
      expect.fail('Expected schema drift')
    } catch (error) {
      expect(error).toBeInstanceOf(HermesSchemaDrift)
      expect(error).toMatchObject({ table, column })
      expect((error as Error).message).toContain(column)
    }
  },
)

test('kanban readers return task details, every run column, both link directions and comments', () => {
  const { db, path } = fixtures.build('kanban')
  insertTask(db)
  insertTask(db, 'task-2')
  db.exec(`
    UPDATE tasks SET current_run_id = 1, block_kind = 'needs_input', session_id = 'session-1',
      workflow_template_id = 'example', current_step_key = 'build', result = 'Example result';
    INSERT INTO task_runs (task_id, profile, status, started_at, worker_started_at)
      VALUES ('task-1', 'builder', 'running', 2000, 'boot|2000');
    INSERT INTO task_comments (task_id, author, body, created_at)
      VALUES ('task-1', 'reviewer', 'Example feedback', 3000);
    INSERT INTO task_links (parent_id, child_id) VALUES ('task-1', 'task-2');
  `)
  const reader = open(path)
  expect(readTasks(reader, ['task-1'])).toEqual({
    rows: [
      {
        id: 'task-1',
        title: 'Build example feature',
        body: 'Generic task body',
        assignee: 'builder',
        status: 'todo',
        priority: 0,
        created_by: 'lead',
        created_at: 2000,
        started_at: null,
        completed_at: null,
        current_run_id: 1,
        block_kind: 'needs_input',
        session_id: 'session-1',
        result: 'Example result',
        workflow_template_id: 'example',
        current_step_key: 'build',
      },
    ],
    malformed: 0,
  })
  expect(readTaskRuns(reader, { taskIds: ['task-1'] })).toEqual({
    rows: [
      {
        id: 1,
        task_id: 'task-1',
        profile: 'builder',
        step_key: null,
        status: 'running',
        claim_lock: null,
        claim_expires: null,
        worker_pid: null,
        worker_started_at: 'boot|2000',
        max_runtime_seconds: null,
        last_heartbeat_at: null,
        started_at: 2000,
        ended_at: null,
        outcome: null,
        summary: null,
        metadata: null,
        error: null,
      },
    ],
    malformed: 0,
  })
  for (const taskId of ['task-1', 'task-2']) {
    expect(readTaskLinks(reader, { taskIds: [taskId] }).rows).toEqual([
      { parent_id: 'task-1', child_id: 'task-2' },
    ])
  }
  expect(readTaskComments(reader, { taskIds: ['task-1'] }).rows).toEqual([
    { id: 1, task_id: 'task-1', author: 'reviewer', body: 'Example feedback', created_at: 3000 },
  ])
})

test('sessions and messages preserve identity, flags, token counts and cost fields', () => {
  const { db, path } = fixtures.build('state')
  insertSession(db)
  db.exec(`UPDATE sessions SET message_count = 2, tool_call_count = 1, input_tokens = 100,
    output_tokens = 50, cache_read_tokens = 20, cache_write_tokens = 10, reasoning_tokens = 5,
    estimated_cost_usd = 0.1, actual_cost_usd = 0.09, last_activity_at = 3000;
    INSERT INTO messages (session_id, role, tool_call_id, tool_name, timestamp, active, compacted,
      message_uid, tool_call_uid) VALUES ('session-1', 'tool', 'call-1', 'example-tool', 2000, 0, 1,
      'message-1', 'tool-1');`)
  const reader = open(path)
  expect(readSessions(reader, ['session-1'])).toEqual({
    rows: [
      {
        id: 'session-1',
        source: 'cli',
        profile_name: 'builder',
        model: 'example-model',
        title: null,
        started_at: 2000,
        ended_at: null,
        end_reason: null,
        message_count: 2,
        tool_call_count: 1,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 20,
        cache_write_tokens: 10,
        reasoning_tokens: 5,
        estimated_cost_usd: 0.1,
        actual_cost_usd: 0.09,
        last_activity_at: 3000,
        parent_session_id: null,
      },
    ],
    malformed: 0,
  })
  expect(tailMessages(reader, { afterId: 0, limit: 10 }).rows).toEqual([
    {
      id: 1,
      session_id: 'session-1',
      role: 'tool',
      content: null,
      tool_call_id: 'call-1',
      tool_calls: null,
      tool_name: 'example-tool',
      timestamp: 2000,
      active: 0,
      compacted: 1,
      message_uid: 'message-1',
      tool_call_uid: 'tool-1',
    },
  ])
})

test('all ID-list readers chunk at 500, deduplicate inputs and return empty batches', () => {
  const kanban = fixtures.build('kanban')
  const state = fixtures.build('state')
  const ids = Array.from({ length: 1001 }, (_, index) => `example-${index}`)
  for (const id of ids) {
    insertTask(kanban.db, id)
    insertSession(state.db, id)
    kanban.db
      .prepare(`INSERT INTO task_runs (task_id, status, started_at) VALUES (?, 'running', 2000)`)
      .run(id)
    kanban.db
      .prepare(
        `INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?, 'designer', 'Example comment', 2000)`,
      )
      .run(id)
  }
  kanban.db
    .prepare('INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)')
    .run(ids[0]!, ids[1000]!)
  const kanbanReader = open(kanban.path)
  const stateReader = open(state.path)
  const prepareKanban = vi.spyOn(kanbanReader, 'prepare')
  const prepareState = vi.spyOn(stateReader, 'prepare')
  for (const read of [
    (list: string[]) => readTasks(kanbanReader, list),
    (list: string[]) => readTaskRuns(kanbanReader, { taskIds: list }),
    (list: string[]) => readTaskComments(kanbanReader, { taskIds: list }),
    (list: string[]) => readSessions(stateReader, list),
  ]) {
    expect(read([...ids, ids[0]!]).rows).toHaveLength(1001)
    expect(read([])).toEqual({ rows: [], malformed: 0 })
  }
  expect(readTaskLinks(kanbanReader, { taskIds: ids })).toEqual({
    rows: [{ parent_id: ids[0], child_id: ids[1000] }],
    malformed: 0,
  })
  expect(readTaskLinks(kanbanReader, { taskIds: [] })).toEqual({ rows: [], malformed: 0 })
  expect(prepareKanban).toHaveBeenCalledTimes(12)
  expect(prepareState).toHaveBeenCalledTimes(3)
  for (const [sql] of [...prepareKanban.mock.calls, ...prepareState.mock.calls]) {
    for (const list of sql.matchAll(/IN \(([^)]+)\)/g)) {
      expect(list[1]!.split(',').length).toBeLessThanOrEqual(500)
    }
  }
})

test('reader inputs and checkpoints reject invalid cursors, limits and IDs', () => {
  const { path, tailer } = setup(sources[0])
  const reader = open(path)
  for (const input of [
    { afterId: -1, limit: 10 },
    { afterId: 0.5, limit: 10 },
    { afterId: 0, limit: 0 },
    { afterId: 0, limit: 1.5 },
  ]) {
    expect(() => tailTaskEvents(reader, input)).toThrow(ZodError)
    expect(() => tailMessages(reader, input)).toThrow(ZodError)
  }
  expect(() => readTasks(reader, [''])).toThrow(ZodError)
  expect(() => readTaskRuns(reader, { taskIds: [''] })).toThrow(ZodError)
  expect(() => tailer.poll({ position: -1, incarnation: 'file' })).toThrow(ZodError)
  expect(() => tailer.poll({ position: 1, incarnation: '' })).toThrow(ZodError)
  expect(() => createTailer({ path, scope: '', read: () => [], idOf: () => 1 })).toThrow(ZodError)
})

test('tailer supports row-array callbacks and finds the maximum ID', () => {
  const { path } = fixtures.build('kanban')
  const tailer = createTailer({
    path,
    scope: 'tasks',
    read: () => [{ id: 4 }, { id: 2 }],
    idOf: (row) => row.id,
  })
  tailers.push(tailer)
  expect(tailer.poll().checkpoint.position).toBe(4)
})

test('the Hermes home defaults to ~/.hermes inside the adapter', async () => {
  const { resolveHermesHome } = await import('../../../src/hermes/live/paths.ts')
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  expect(resolveHermesHome()).toBe(join(homedir(), '.hermes'))
  expect(resolveHermesHome('/srv/hermes')).toBe('/srv/hermes')
})

test('incarnation is stable across writes and changes only when the file is replaced', async () => {
  const { mkdtempSync, renameSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const { incarnationOf } = await import('../../../src/hermes/live/sqlite.ts')
  const dir = mkdtempSync(join(tmpdir(), 'score-incarnation-'))
  try {
    const path = join(dir, 'state.db')
    const writer = new DatabaseSync(path)
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const before = incarnationOf(path)
    for (let i = 0; i < 20; i++) writer.prepare('INSERT INTO t (v) VALUES (?)').run(`row ${i}`)
    writer.close()
    expect(incarnationOf(path)).toBe(before)
    const replacement = new DatabaseSync(join(dir, 'next.db'))
    replacement.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    replacement.close()
    renameSync(join(dir, 'next.db'), path)
    expect(incarnationOf(path)).not.toBe(before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
