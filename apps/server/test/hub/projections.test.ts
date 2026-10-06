import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ScoreDb } from '../../src/db/index.ts'
import { defineLifecycle, guardedUpsert } from '../../src/hub/index.ts'

const states = ['queued', 'running', 'completed', 'failed'] as const
const lifecycle = defineLifecycle({ states, terminal: ['completed', 'failed'], order: states })
let db: ScoreDb

beforeEach(() => {
  db = new ScoreDb(new DatabaseSync(':memory:'))
  db.sqlite.exec(`CREATE TABLE test_runs (
    source TEXT NOT NULL, id TEXT NOT NULL, state TEXT, updated_at TEXT,
    PRIMARY KEY (source, id)
  ) STRICT`)
})

afterEach(() => db.close())

test.each(states)('lifecycle allows idempotent writes in %s', (state) => {
  expect(lifecycle.canTransition(state, state)).toBe(true)
})

test.each(['completed', 'failed'] as const)(
  'terminal %s cannot transition to any other state',
  (from) => {
    for (const to of states) expect(lifecycle.canTransition(from, to)).toBe(from === to)
  },
)

test('lifecycle permits forward transitions and rejects backward and unknown states', () => {
  expect(lifecycle.canTransition('queued', 'running')).toBe(true)
  expect(lifecycle.canTransition('queued', 'completed')).toBe(true)
  expect(lifecycle.canTransition('running', 'queued')).toBe(false)
  expect(() => lifecycle.canTransition('unknown' as (typeof states)[number], 'queued')).toThrow()
  expect(() => lifecycle.canTransition('queued', 'unknown' as (typeof states)[number])).toThrow()
})

test.each([
  { states: [], terminal: [], order: [] },
  { states: ['queued', 'queued'], terminal: [], order: ['queued'] },
  { states: ['queued', 'running'], terminal: [], order: ['queued'] },
  { states: ['queued', 'running'], terminal: [], order: ['queued', 'queued'] },
  { states: ['queued'], terminal: ['unknown'], order: ['queued'] },
  { states: ['queued'], terminal: [], order: ['unknown'] },
])('invalid lifecycle configuration %j is rejected', (config) => {
  expect(() => defineLifecycle(config)).toThrow()
})

function upsert(state: string, updatedAt: string, id = 'run') {
  return guardedUpsert(db.sqlite, {
    table: 'test_runs',
    key: { source: 'score', id },
    stateColumn: 'state',
    lifecycle,
    values: { state, updated_at: updatedAt },
  })
}

test('composite keys isolate rows and blocked writes preserve every column', () => {
  db.tx(() => {
    expect(upsert('running', 'first')).toBe('applied')
    expect(upsert('queued', 'delayed')).toBe('ignored_regression')
    expect(db.sqlite.prepare('SELECT * FROM test_runs').all()).toEqual([
      { source: 'score', id: 'run', state: 'running', updated_at: 'first' },
    ])
    expect(upsert('completed', 'terminal')).toBe('applied')
    expect(upsert('failed', 'different-terminal')).toBe('ignored_terminal')
    expect(upsert('running', 'delayed')).toBe('ignored_terminal')
    expect(upsert('queued', 'another-row', 'other')).toBe('applied')
  })
  expect(db.sqlite.prepare('SELECT * FROM test_runs ORDER BY id').all()).toEqual([
    { source: 'score', id: 'other', state: 'queued', updated_at: 'another-row' },
    { source: 'score', id: 'run', state: 'completed', updated_at: 'terminal' },
  ])
})

test.each(['completed', 'failed'] as const)(
  'terminal %s rows ignore same-state updates unless refresh is explicitly enabled',
  (state) => {
    db.tx(() => {
      upsert(state, 'first')
      const before = db.sqlite.prepare('SELECT * FROM test_runs').all()
      expect(upsert(state, 'stale')).toBe('ignored_terminal')
      expect(db.sqlite.prepare('SELECT * FROM test_runs').all()).toEqual(before)
      expect(
        guardedUpsert(db.sqlite, {
          table: 'test_runs',
          key: { source: 'score', id: 'run' },
          stateColumn: 'state',
          lifecycle,
          values: { state, updated_at: 'enriched' },
          refreshTerminal: true,
        }),
      ).toBe('applied')
    })
    expect(db.sqlite.prepare('SELECT state, updated_at FROM test_runs').get()).toEqual({
      state,
      updated_at: 'enriched',
    })
  },
)

test.each(['queued', 'running', 'failed'] as const)(
  'terminal refresh cannot move a completed row to %s',
  (state) => {
    db.tx((sqlite) => {
      upsert('completed', 'first')
      const before = sqlite.prepare('SELECT * FROM test_runs').all()
      expect(
        guardedUpsert(sqlite, {
          table: 'test_runs',
          key: { source: 'score', id: 'run' },
          stateColumn: 'state',
          lifecycle,
          values: { state, updated_at: 'stale' },
          refreshTerminal: true,
        }),
      ).toBe('ignored_terminal')
      expect(sqlite.prepare('SELECT * FROM test_runs').all()).toEqual(before)
    })
  },
)

test('non-terminal same-state updates still refresh non-state columns by default', () => {
  db.tx(() => {
    upsert('running', 'first')
    expect(upsert('running', 'enriched')).toBe('applied')
  })
  expect(db.sqlite.prepare('SELECT state, updated_at FROM test_runs').get()).toEqual({
    state: 'running',
    updated_at: 'enriched',
  })
})

test('guard requires an active transaction', () => {
  expect(() => upsert('queued', 'first')).toThrow('require a transaction')
  expect(db.sqlite.prepare('SELECT * FROM test_runs').all()).toEqual([])
})

test.each(['unknown', null])('invalid stored state %s fails closed', (state) => {
  db.sqlite.prepare('INSERT INTO test_runs VALUES (?, ?, ?, ?)').run('score', 'run', state, 'first')
  expect(() => db.tx(() => upsert('queued', 'new'))).toThrow()
  expect(db.sqlite.prepare('SELECT state, updated_at FROM test_runs').get()).toEqual({
    state,
    updated_at: 'first',
  })
})

test('invalid incoming state fails before inserting a row', () => {
  expect(() => db.tx(() => upsert('unknown', 'first'))).toThrow()
  expect(db.sqlite.prepare('SELECT * FROM test_runs').all()).toEqual([])
})

const invalidUpserts: Partial<Parameters<typeof guardedUpsert>[1]>[] = [
  { table: 'test_runs; DROP TABLE test_runs' },
  { key: { 'id OR 1=1': 'run' } },
  { stateColumn: 'state FROM test_runs' },
  { values: { state: 'queued', 'updated_at) VALUES (1);': 'value' } },
  { key: {} },
  { key: { source: 'score', id: null } },
  { values: { state: 'queued', id: 'different' } },
]

test.each(invalidUpserts)(
  'unsafe or inconsistent SQL configuration %j is rejected',
  (overrides) => {
    expect(() =>
      db.tx((sqlite) =>
        guardedUpsert(sqlite, {
          table: 'test_runs',
          key: { source: 'score', id: 'run' },
          stateColumn: 'state',
          lifecycle,
          values: { state: 'queued', updated_at: 'first' },
          ...overrides,
        }),
      ),
    ).toThrow()
    expect(db.sqlite.prepare('SELECT * FROM test_runs').all()).toEqual([])
  },
)

test('projection values are bound as data, including SQL-looking key values', () => {
  const id = "run'); DROP TABLE test_runs; --"
  db.tx(() => upsert('queued', 'first', id))
  expect(db.sqlite.prepare('SELECT id FROM test_runs').get()).toEqual({ id })
})

test('omitted non-state columns are preserved on updates', () => {
  db.tx((sqlite) => {
    upsert('queued', 'first')
    guardedUpsert(sqlite, {
      table: 'test_runs',
      key: { source: 'score', id: 'run' },
      stateColumn: 'state',
      lifecycle,
      values: { state: 'running' },
    })
  })
  expect(db.sqlite.prepare('SELECT state, updated_at FROM test_runs').get()).toEqual({
    state: 'running',
    updated_at: 'first',
  })
})

test.each(['simple', 'composite'] as const)(
  'identifier casing cannot bypass terminal guards with %s keys',
  (kind) => {
    db.sqlite.exec(
      'CREATE TABLE simple_runs (id TEXT PRIMARY KEY, state TEXT, updated_at TEXT) STRICT',
    )
    const table = kind === 'simple' ? 'simple_runs' : 'test_runs'
    const key: Record<string, SQLInputValue> =
      kind === 'simple' ? { ID: 'terminal' } : { SOURCE: 'score', ID: 'terminal' }
    db.tx((sqlite) => {
      guardedUpsert(sqlite, {
        table: table.toUpperCase(),
        key,
        stateColumn: 'STATE',
        lifecycle,
        values: { STATE: 'completed', UPDATED_AT: 'first' },
      })
      expect(
        guardedUpsert(sqlite, {
          table,
          key,
          stateColumn: 'state',
          lifecycle,
          values: { state: 'running', updated_at: 'stale' },
        }),
      ).toBe('ignored_terminal')
      const before = sqlite.prepare(`SELECT * FROM ${table}`).all()
      const conflictingKey: Record<string, SQLInputValue> =
        kind === 'simple' ? { ID: 'different-row' } : { SOURCE: 'score', ID: 'different-row' }
      expect(() =>
        guardedUpsert(sqlite, {
          table,
          key: conflictingKey,
          stateColumn: 'state',
          lifecycle,
          values: { id: 'terminal', state: 'running' },
        }),
      ).toThrow('Conflicting identifier casing')
      expect(sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual(before)
    })
  },
)

const aliases: Partial<Parameters<typeof guardedUpsert>[1]>[] = [
  { key: { id: 'run', ID: 'run', source: 'score' } },
  { values: { state: 'queued', STATE: 'queued' } },
  { key: { ID: 'run', source: 'score' }, values: { id: 'run', state: 'queued' } },
  { key: { source: 'score', SOURCE: 'score', id: 'run' } },
  { key: { source: 'score', id: 'run' }, values: { Source: 'score', state: 'queued' } },
]

test.each(aliases)('case-only aliases %j are rejected even if values agree', (override) => {
  expect(() =>
    db.tx((sqlite) =>
      guardedUpsert(sqlite, {
        table: 'test_runs',
        key: { source: 'score', id: 'run' },
        stateColumn: 'state',
        lifecycle,
        values: { state: 'queued' },
        ...override,
      }),
    ),
  ).toThrow('Conflicting identifier casing')
  expect(db.sqlite.prepare('SELECT * FROM test_runs').all()).toEqual([])
})

test.each(['completed', 'running'] as const)(
  'version checks preserve %s projections on stale observations while allowing newer and equal versions',
  (state) => {
    db.sqlite.exec('ALTER TABLE test_runs ADD COLUMN revision INTEGER')
    function versioned(revision: number, label: string, refreshTerminal = true) {
      return guardedUpsert(db.sqlite, {
        table: 'TEST_RUNS',
        key: { source: 'score', id: 'run' },
        stateColumn: 'STATE',
        lifecycle,
        values: { state, updated_at: label, revision },
        versionColumn: 'REVISION',
        refreshTerminal,
      })
    }
    db.tx(() => {
      expect(versioned(10, 'initial')).toBe('applied')
      expect(versioned(12, 'newer')).toBe('applied')
      const before = db.sqlite.prepare('SELECT * FROM test_runs').all()
      expect(versioned(11, 'stale')).toBe('ignored_stale')
      expect(db.sqlite.prepare('SELECT * FROM test_runs').all()).toEqual(before)
      expect(versioned(12, 'equal')).toBe('applied')
      if (state === 'completed') expect(versioned(13, 'no-opt-in', false)).toBe('ignored_terminal')
    })
    expect(db.sqlite.prepare('SELECT revision, updated_at FROM test_runs').get()).toEqual({
      revision: 12,
      updated_at: 'equal',
    })
  },
)

test('NULL stored versions allow the first integer version and invalid versions fail closed', () => {
  db.sqlite.exec('ALTER TABLE test_runs ADD COLUMN revision INTEGER')
  db.tx((sqlite) => {
    upsert('completed', 'unversioned')
    expect(
      guardedUpsert(sqlite, {
        table: 'test_runs',
        key: { source: 'score', id: 'run' },
        stateColumn: 'state',
        lifecycle,
        values: { state: 'completed', revision: -10 },
        versionColumn: 'revision',
        refreshTerminal: true,
      }),
    ).toBe('applied')
    for (const revision of [null, '11', 1.5]) {
      expect(() =>
        guardedUpsert(sqlite, {
          table: 'test_runs',
          key: { source: 'score', id: 'run' },
          stateColumn: 'state',
          lifecycle,
          values: { state: 'completed', revision },
          versionColumn: 'revision',
          refreshTerminal: true,
        }),
      ).toThrow()
    }
  })
  expect(db.sqlite.prepare('SELECT revision FROM test_runs').get()).toEqual({ revision: -10 })
})
