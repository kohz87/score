import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { getEpoch, migrate, openDatabase, resetEpoch, type ScoreDb } from '../src/db/index.ts'

const migrationDir = fileURLToPath(new URL('../migrations/', import.meta.url))
let dir: string
const connections: (ScoreDb | DatabaseSync)[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-test-'))
})

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close()
  rmSync(dir, { recursive: true, force: true })
})

function open(): ScoreDb {
  const db = openDatabase(join(dir, 'home', 'score.db'))
  connections.push(db)
  return db
}

function copyMigrations(): string {
  const copy = join(dir, 'migrations')
  mkdirSync(copy)
  cpSync(join(migrationDir, '0001_infra.sql'), join(copy, '0001_infra.sql'))
  return copy
}

function insertEvent(sqlite: DatabaseSync, type: string): void {
  sqlite
    .prepare('INSERT INTO events (ts, type, data) VALUES (?, ?, ?)')
    .run(new Date().toISOString(), type, '{}')
}

test('fresh db migrates all infrastructure tables and records checksums', () => {
  const db = open()
  migrate(db, migrationDir)
  const sql = readFileSync(join(migrationDir, '0001_infra.sql'), 'utf8')
  const floorsSql = readFileSync(join(migrationDir, '0002_ingest_floors.sql'), 'utf8')
  const runsSql = readFileSync(join(migrationDir, '0003_runs.sql'), 'utf8')
  const bridgeSql = readFileSync(join(migrationDir, '0004_bridge.sql'), 'utf8')
  const approvalsSql = readFileSync(join(migrationDir, '0005_approvals.sql'), 'utf8')
  expect(db.sqlite.prepare('SELECT * FROM schema_migrations').all()).toEqual([
    {
      version: 1,
      name: '0001_infra.sql',
      checksum: createHash('sha256').update(sql).digest('hex'),
      applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    },
    {
      version: 2,
      name: '0002_ingest_floors.sql',
      checksum: createHash('sha256').update(floorsSql).digest('hex'),
      applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    },
    {
      version: 3,
      name: '0003_runs.sql',
      checksum: createHash('sha256').update(runsSql).digest('hex'),
      applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    },
    {
      version: 4,
      name: '0004_bridge.sql',
      checksum: createHash('sha256').update(bridgeSql).digest('hex'),
      applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    },
    {
      version: 5,
      name: '0005_approvals.sql',
      checksum: createHash('sha256').update(approvalsSql).digest('hex'),
      applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    },
  ])
  const tables = db.sqlite
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name",
    )
    .all()
  expect(tables.map((row) => row.name)).toEqual([
    'approval_deliveries',
    'approval_delivery_leases',
    'approval_signals',
    'approvals',
    'command_intents',
    'credentials',
    'events',
    'gaps',
    'ingest_checkpoints',
    'ingest_floors',
    'ingest_keys',
    'meta',
    'producers',
    'runs',
    'schema_migrations',
    'session_tool_calls',
    'sessions',
    'tool_calls',
  ])
  expect(
    db.sqlite
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN ('events_ts', 'gaps_run', 'ingest_keys_position') ORDER BY name",
      )
      .all(),
  ).toEqual([{ name: 'events_ts' }, { name: 'gaps_run' }, { name: 'ingest_keys_position' }])
  expect(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'created_at'").get()).toEqual({
    value: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
  })
})

test('re-running migrations is a no-op including epoch and applied timestamp', () => {
  const db = open()
  migrate(db, migrationDir)
  const before = db.sqlite.prepare('SELECT * FROM schema_migrations').all()
  const meta = db.sqlite.prepare('SELECT * FROM meta ORDER BY key').all()
  const changes = db.sqlite.prepare('SELECT total_changes() AS count').get()
  migrate(db, migrationDir)
  expect(db.sqlite.prepare('SELECT * FROM schema_migrations').all()).toEqual(before)
  expect(db.sqlite.prepare('SELECT * FROM meta ORDER BY key').all()).toEqual(meta)
  expect(db.sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(changes)
})

test('modified applied migration is rejected before any further migration', () => {
  const db = open()
  const copy = copyMigrations()
  migrate(db, copy)
  writeFileSync(
    join(copy, '0001_infra.sql'),
    readFileSync(join(copy, '0001_infra.sql'), 'utf8') + '\n-- changed\n',
  )
  writeFileSync(join(copy, '0002_next.sql'), "INSERT INTO meta VALUES ('next', 'value');")
  expect(() => migrate(db, copy)).toThrow('Applied migration changed: 0001_infra.sql')
  expect(db.sqlite.prepare("SELECT * FROM meta WHERE key = 'next'").get()).toBeUndefined()
})

test.each(['0003_gap.sql', '0001_duplicate.sql', 'invalid.sql'])(
  'invalid migration sequence %s is rejected before applying SQL',
  (name) => {
    const db = open()
    const copy = copyMigrations()
    writeFileSync(join(copy, name), 'SELECT 1;')
    expect(() => migrate(db, copy)).toThrow(
      name.includes('gap')
        ? 'Missing migration number: 2'
        : name.includes('duplicate')
          ? 'Duplicate migration number: 1'
          : 'Invalid migration filename',
    )
    expect(db.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual(
      [],
    )
  },
)

test('migration sequence must start at one', () => {
  const db = open()
  const copy = join(dir, 'migrations')
  mkdirSync(copy)
  writeFileSync(join(copy, '0002_next.sql'), 'SELECT 1;')
  expect(() => migrate(db, copy)).toThrow('Missing migration number: 1')
})

test('empty migration directory is rejected', () => {
  const copy = join(dir, 'migrations')
  mkdirSync(copy)
  expect(() => migrate(open(), copy)).toThrow('Missing migration number: 1')
})

test('database from a newer Score is rejected', () => {
  const db = open()
  migrate(db, migrationDir)
  db.sqlite
    .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
    .run(6, '0006_newer.sql', 'a'.repeat(64), new Date().toISOString())
  expect(() => migrate(db, migrationDir)).toThrow(
    'Database is from a newer Score: unknown applied migration 6',
  )
})

test('a gap in applied migration history is rejected', () => {
  const db = open()
  const copy = copyMigrations()
  writeFileSync(join(copy, '0002_next.sql'), 'SELECT 1;')
  migrate(db, copy)
  db.sqlite.exec('DELETE FROM schema_migrations WHERE version = 1')
  expect(() => migrate(db, copy)).toThrow('Missing applied migration number: 1')
})

test('later migrations run in order in separate transactions', () => {
  const db = open()
  const copy = copyMigrations()
  writeFileSync(
    join(copy, '0003_third.sql'),
    "UPDATE meta SET value = value || '-third' WHERE key = 'order';",
  )
  writeFileSync(join(copy, '0002_second.sql'), "INSERT INTO meta VALUES ('order', 'second');")
  migrate(db, copy)
  expect(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'order'").get()).toEqual({
    value: 'second-third',
  })
  expect(db.sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(
    [{ version: 1 }, { version: 2 }, { version: 3 }],
  )
})

test('failed migration rolls back its writes and ledger entry while preserving previous migrations', () => {
  const db = open()
  const copy = copyMigrations()
  writeFileSync(
    join(copy, '0002_failure.sql'),
    "INSERT INTO meta VALUES ('partial', 'value'); INSERT INTO missing_table VALUES (1);",
  )
  expect(() => migrate(db, copy)).toThrow('no such table')
  expect(db.sqlite.prepare("SELECT * FROM meta WHERE key = 'partial'").get()).toBeUndefined()
  expect(db.sqlite.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }])
  expect(getEpoch(db)).toMatch(/^[a-f0-9]{32}$/)
  writeFileSync(join(copy, '0002_failure.sql'), "INSERT INTO meta VALUES ('partial', 'complete');")
  migrate(db, copy)
  expect(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'partial'").get()).toEqual({
    value: 'complete',
  })
})

test('failed first migration leaves no tables or epoch', () => {
  const db = open()
  const copy = copyMigrations()
  writeFileSync(
    join(copy, '0001_infra.sql'),
    readFileSync(join(copy, '0001_infra.sql'), 'utf8') + '\nINVALID SQL;',
  )
  expect(() => migrate(db, copy)).toThrow()
  expect(db.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([])
  cpSync(join(migrationDir, '0001_infra.sql'), join(copy, '0001_infra.sql'))
  migrate(db, copy)
  expect(getEpoch(db)).toMatch(/^[a-f0-9]{32}$/)
})

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
