import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { migrate } from '../src/db/index.ts'
import { connections, dir, insertEvent, migrationDir, open } from './db-helpers.ts'

test('database applies WAL, normal synchronization, foreign keys and busy timeout', () => {
  const db = open()
  expect(db.sqlite.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
  expect(db.sqlite.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 1 })
  expect(db.sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
  expect(db.sqlite.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
})

test('database and new parent directory have private modes, including WAL sidecars', () => {
  const db = open()
  migrate(db, migrationDir)
  expect(statSync(join(dir, 'home')).mode & 0o777).toBe(0o700)
  for (const filename of ['score.db', 'score.db-wal', 'score.db-shm']) {
    expect(statSync(join(dir, 'home', filename)).mode & 0o777).toBe(0o600)
  }
})

test('opening an existing database corrects its file mode', () => {
  const db = open()
  db.close()
  connections.pop()
  chmodSync(join(dir, 'home', 'score.db'), 0o644)
  open()
  expect(statSync(join(dir, 'home', 'score.db')).mode & 0o777).toBe(0o600)
})

test('opening tightens an existing, too-open parent directory', () => {
  mkdirSync(join(dir, 'home'), { mode: 0o755 })
  chmodSync(join(dir, 'home'), 0o755)
  open()
  expect(statSync(join(dir, 'home')).mode & 0o777).toBe(0o700)
})

test('events and gaps support STRICT with AUTOINCREMENT and never reuse deleted IDs', () => {
  const db = open()
  migrate(db, migrationDir)
  expect(
    db.sqlite
      .prepare(
        "SELECT name, strict FROM pragma_table_list WHERE name IN ('events', 'gaps') ORDER BY name",
      )
      .all(),
  ).toEqual([
    { name: 'events', strict: 1 },
    { name: 'gaps', strict: 1 },
  ])
  insertEvent(db.sqlite, 'first')
  db.sqlite.exec('DELETE FROM events')
  insertEvent(db.sqlite, 'second')
  expect(db.sqlite.prepare('SELECT seq FROM events').get()).toEqual({ seq: 2 })
  expect(() =>
    db.sqlite
      .prepare('INSERT INTO gaps (source, from_ts, reason) VALUES (?, ?, ?)')
      .run('test', Buffer.from('invalid'), 'test'),
  ).toThrow()
})
