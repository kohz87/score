import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'
import { defaultJobId } from '../src/domain/job-sessions.ts'

// PLAN 11.1b migration 0081: room-scoped rows move to the default job; rows of a deleted room are dropped.
const SRC = fileURLToPath(new URL('../migrations/', import.meta.url))
const at = '2026-10-24T12:00:00.000Z'
let dir: string
let db: ScoreDb
let migrations: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-job-scope-migration-'))
  db = openDatabase(join(dir, 'score.db'))
  migrations = join(dir, 'migrations')
  mkdirSync(migrations)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function copyUntil(name: string) {
  for (const file of readdirSync(SRC).filter((file) => file.endsWith('.sql') && file < name))
    copyFileSync(join(SRC, file), join(migrations, file))
}

test('0081 moves reads, shares, CLI sessions and pending terminals to the default job', () => {
  copyUntil('0081_exchanges.sql')
  migrate(db, migrations)

  db.sqlite
    .prepare(
      "INSERT INTO rooms (id, name, kind, lead_agent_id, members, created_at, updated_at) VALUES ('r1', '#release', 'room', 'lead', '[\"lead\",\"builder\"]', ?, ?)",
    )
    .run(at, at)
  db.sqlite
    .prepare(
      'INSERT INTO room_reads (room_id, last_read_message_created_at, last_read_message_id) VALUES (?, ?, ?)',
    )
    .run('r1', at, 'message-1')
  db.sqlite
    .prepare(
      `INSERT INTO room_shares (id, room_id, token_hash, created_at, expires_at, revoked_at, include_images, snapshot)
       VALUES ('share-1', 'r1', 'hash-1', ?, '2026-11-01T00:00:00.000Z', NULL, 0, '{"title":"old","messages":[],"images":[]}')`,
    )
    .run(at)
  db.sqlite
    .prepare(
      'INSERT INTO coding_sessions (room_id, agent_id, session_id, updated_at, instructions_hash) VALUES (?, ?, ?, ?, ?)',
    )
    .run('r1', 'builder', 'cli-r1', at, 'instructions-hash')
  // A room deleted before the upgrade: its CLI session has no job to move to.
  db.sqlite
    .prepare(
      'INSERT INTO coding_sessions (room_id, agent_id, session_id, updated_at, instructions_hash) VALUES (?, ?, ?, ?, ?)',
    )
    .run('deleted-room', 'builder', 'cli-gone', at, null)
  db.sqlite
    .prepare(
      `INSERT INTO coding_pending_terminals (run_id, agent_id, room_id, usage, info, created_at)
       VALUES ('pending-1', 'builder', 'r1', NULL, '{}', ?)`,
    )
    .run(at)

  const job = defaultJobId(db.sqlite, 'r1')!
  copyFileSync(join(SRC, '0081_exchanges.sql'), join(migrations, '0081_exchanges.sql'))
  migrate(db, migrations)

  expect(db.sqlite.prepare('SELECT job_id, last_read_message_id FROM job_reads').all()).toEqual([
    { job_id: job, last_read_message_id: 'message-1' },
  ])
  expect(db.sqlite.prepare('SELECT job_id FROM room_shares WHERE id = ?').get('share-1')).toEqual({
    job_id: job,
  })
  expect(
    db.sqlite
      .prepare('SELECT job_id, agent_id, session_id, instructions_hash FROM coding_sessions')
      .all(),
  ).toEqual([
    {
      job_id: job,
      agent_id: 'builder',
      session_id: 'cli-r1',
      instructions_hash: 'instructions-hash',
    },
  ])
  expect(
    db.sqlite
      .prepare('SELECT job_id FROM coding_pending_terminals WHERE run_id = ?')
      .get('pending-1'),
  ).toEqual({ job_id: job })
  expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})
