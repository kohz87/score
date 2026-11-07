import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { getEpoch, migrate, resetEpoch } from '../src/db/index.ts'
import { connections, dir, insertEvent, migrationDir, open } from './db-helpers.ts'

test('epoch is stable across reopen and reset changes it durably', () => {
  const db = open()
  migrate(db, migrationDir)
  const epoch = getEpoch(db)
  expect(epoch).toMatch(/^[a-f0-9]{32}$/)
  db.close()
  connections.pop()
  const reopened = open()
  migrate(reopened, migrationDir)
  expect(getEpoch(reopened)).toBe(epoch)
  const reset = resetEpoch(reopened)
  expect(reset).toMatch(/^[a-f0-9]{32}$/)
  expect(reset).not.toBe(epoch)
  reopened.close()
  connections.pop()
  const restored = open()
  migrate(restored, migrationDir)
  expect(getEpoch(restored)).toBe(reset)
})

test('tx commits return values and rolls back a thrown error without partial writes', () => {
  const db = open()
  migrate(db, migrationDir)
  expect(
    db.tx((sqlite) => {
      insertEvent(sqlite, 'committed')
      return 42
    }),
  ).toBe(42)
  const failure = new Error('abort')
  expect(() =>
    db.tx((sqlite) => {
      insertEvent(sqlite, 'partial')
      throw failure
    }),
  ).toThrow(failure)
  expect(db.sqlite.prepare('SELECT type FROM events').all()).toEqual([{ type: 'committed' }])
  expect(db.sqlite.isTransaction).toBe(false)
})

test.each(['tx', 'read'] as const)(
  'nested %s transactions throw and roll back the outer transaction',
  (method) => {
    const db = open()
    migrate(db, migrationDir)
    expect(() =>
      db.tx((sqlite) => {
        insertEvent(sqlite, 'partial')
        db[method](() => undefined)
      }),
    ).toThrow('Nested transactions')
    expect(db.sqlite.prepare('SELECT * FROM events').all()).toEqual([])
    expect(() => db.read(() => db.read(() => undefined))).toThrow('Nested transactions')
  },
)

test('asynchronous transaction callbacks are rejected and synchronous writes roll back', () => {
  const db = open()
  migrate(db, migrationDir)
  expect(() =>
    db.tx((sqlite) => {
      insertEvent(sqlite, 'partial')
      return Promise.resolve()
    }),
  ).toThrow('must be synchronous')
  expect(db.sqlite.prepare('SELECT * FROM events').all()).toEqual([])
})

test('read holds a consistent WAL snapshot while another DatabaseSync connection writes', () => {
  const db = open()
  migrate(db, migrationDir)
  insertEvent(db.sqlite, 'before')
  const writer = new DatabaseSync(join(dir, 'home', 'score.db'))
  connections.push(writer)
  expect(
    db.read((sqlite) => {
      expect(sqlite.prepare('SELECT max(seq) AS head FROM events').get()).toEqual({ head: 1 })
      insertEvent(writer, 'during')
      expect(sqlite.prepare('SELECT type FROM events').all()).toEqual([{ type: 'before' }])
      return sqlite.prepare('SELECT max(seq) AS head FROM events').get()
    }),
  ).toEqual({ head: 1 })
  expect(db.sqlite.prepare('SELECT max(seq) AS head FROM events').get()).toEqual({ head: 2 })
})

test('read rolls back on error and releases its snapshot', () => {
  const db = open()
  migrate(db, migrationDir)
  expect(() =>
    db.read(() => {
      throw new Error('read failed')
    }),
  ).toThrow('read failed')
  expect(db.sqlite.isTransaction).toBe(false)
  expect(db.read(() => getEpoch(db))).toMatch(/^[a-f0-9]{32}$/)
})
