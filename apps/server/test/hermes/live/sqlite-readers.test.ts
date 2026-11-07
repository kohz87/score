import type { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { ZodError } from 'zod'
import {
  createTailer,
  HermesSchemaDrift,
  readSessions,
  readTaskComments,
  readTaskLinks,
  readTaskRuns,
  readTasks,
  tailMessages,
  tailTaskEvents,
} from '../../../src/hermes/live/index.ts'
import { insertSession, insertTask } from '../../fixtures/hermes/sqlite-fixture.ts'
import { fixtures, installSqliteHooks, open, setup, sources } from './sqlite-helpers.ts'

installSqliteHooks()

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
