import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ScoreDb } from '../../src/db/index.ts'
import { pruneEvents, retainEvents } from '../../src/hub/retention.ts'
import { headSeq } from '../../src/hub/snapshot.ts'

let db: ScoreDb
beforeEach(() => {
  db = new ScoreDb(new DatabaseSync(':memory:'))
  db.sqlite.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT)')
})
afterEach(() => {
  db.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test('prune deletes old rows in bounded transactions, preserves cutoff equality and never lowers head', () => {
  const insert = db.sqlite.prepare('INSERT INTO events (ts) VALUES (?)')
  for (let i = 0; i < 5; i++) insert.run('2026-09-01T00:00:00.000Z')
  insert.run('2026-10-01T00:00:00.000Z')
  insert.run('2026-10-02T00:00:00.000Z')
  const transactions = vi.spyOn(db, 'tx')
  expect(pruneEvents(db, { olderThan: '2026-10-01T00:00:00.000Z', batchSize: 2 })).toBe(5)
  expect(transactions.mock.results.map((result) => result.value)).toEqual([2, 2, 1])
  expect(db.sqlite.prepare('SELECT seq FROM events ORDER BY seq').all()).toEqual([
    { seq: 6 },
    { seq: 7 },
  ])
  expect(headSeq(db.sqlite)).toBe(7)
  expect(pruneEvents(db, { olderThan: '2026-11-01T00:00:00.000Z' })).toBe(2)
  expect(headSeq(db.sqlite)).toBe(7)
  expect(insert.run('2026-11-02T00:00:00.000Z').lastInsertRowid).toBe(8)
})

test('default retention is seven days and batches are 5000', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'))
  const insert = db.sqlite.prepare('INSERT INTO events (ts) VALUES (?)')
  db.tx(() => {
    for (let i = 0; i < 5001; i++) insert.run('2026-09-30T23:59:59.999Z')
    insert.run('2026-10-01T00:00:00.000Z')
  })
  const transactions = vi.spyOn(db, 'tx')
  expect(pruneEvents(db)).toBe(5001)
  expect(transactions.mock.results.map((result) => result.value)).toEqual([5000, 1])
  expect(headSeq(db.sqlite)).toBe(5002)
})

test.each([{ batchSize: 0 }, { batchSize: -1 }, { batchSize: 1.5 }, { olderThan: 'bad' }])(
  'invalid retention options %j reject before writing',
  (options) => {
    expect(() => pruneEvents(db, options)).toThrow()
    expect(db.sqlite.isTransaction).toBe(false)
  },
)

test('release is idempotent and cannot remove protection held by a later replay', () => {
  db.sqlite.prepare('INSERT INTO events (ts) VALUES (?)').run('2026-09-01T00:00:00.000Z')
  const first = retainEvents(db)
  first.release()
  const later = retainEvents(db)
  first.release()
  expect(pruneEvents(db, { olderThan: '2026-10-01T00:00:00.000Z' })).toBe(0)
  later.release()
  expect(pruneEvents(db, { olderThan: '2026-10-01T00:00:00.000Z' })).toBe(1)
})
