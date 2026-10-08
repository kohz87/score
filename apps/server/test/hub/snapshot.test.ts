import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ScoreDb } from '../../src/db/index.ts'
import { snapshot } from '../../src/hub/index.ts'

let db: ScoreDb
beforeEach(() => {
  db = new ScoreDb(new DatabaseSync(':memory:'))
  db.sqlite.exec(`CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE runs (id TEXT PRIMARY KEY);
    INSERT INTO events DEFAULT VALUES;
    INSERT INTO runs VALUES ('one')`)
})
afterEach(() => db.close())

test('the SQLite iterate reproduction is rejected before a lazy result escapes COMMIT', () => {
  expect(() =>
    snapshot(db, (sqlite) => sqlite.prepare('SELECT id FROM runs ORDER BY id').iterate()),
  ).toThrow('materialized')
  expect(db.sqlite.isTransaction).toBe(false)
  db.tx((sqlite) => {
    sqlite.exec("INSERT INTO runs VALUES ('two'); INSERT INTO events DEFAULT VALUES")
  })
  expect(snapshot(db, (sqlite) => sqlite.prepare('SELECT id FROM runs ORDER BY id').all())).toEqual(
    {
      asOfSeq: 2,
      data: [{ id: 'one' }, { id: 'two' }],
    },
  )
})

const lazy: [string, () => unknown][] = [
  ['function', () => () => 'later'],
  ['promise', () => Promise.resolve([])],
  ['thenable', () => ({ then: () => undefined })],
  [
    'generator',
    () =>
      (function* () {
        yield 'later'
      })(),
  ],
  ['iterator', () => ({ next: () => ({ done: true }) })],
  ['set', () => new Set(['one'])],
  ['map', () => new Map([['id', 'one']])],
  [
    'plain iterable',
    () => ({
      *[Symbol.iterator]() {
        yield 'later'
      },
    }),
  ],
  [
    'accessor',
    () => ({
      get id() {
        return 'later'
      },
    }),
  ],
]

test.each(lazy)(
  'snapshot rejects %s at the root and within plain objects and arrays',
  (_label, make) => {
    for (const value of [make(), { items: [make()] }]) {
      expect(() => snapshot(db, () => value)).toThrow()
      expect(db.sqlite.isTransaction).toBe(false)
    }
  },
)

test('materialized primitives, plain objects, SQLite rows and large primitive arrays are accepted', () => {
  const data = {
    number: 1,
    text: 'one',
    boolean: true,
    absent: null,
    items: [0, 'two'],
    empty: Object.create(null) as Record<string, unknown>,
  }
  expect(snapshot(db, () => data)).toEqual({ asOfSeq: 1, data })
  for (const value of [null, true, 'one', 0]) expect(snapshot(db, () => value).data).toBe(value)
  const items = Array.from({ length: 100_000 }, (_, index) => index)
  expect(snapshot(db, () => items).data).toBe(items)
})

test('deep or cyclic structures are rejected at a bounded depth', () => {
  let nested: unknown = 'leaf'
  for (let index = 0; index < 16; index++) nested = { child: nested }
  expect(snapshot(db, () => nested).data).toBe(nested)
  nested = { child: nested }
  expect(() => snapshot(db, () => nested)).toThrow('maximum depth')
  const cyclic: { child?: unknown } = {}
  cyclic.child = cyclic
  expect(() => snapshot(db, () => cyclic)).toThrow('maximum depth')
})
