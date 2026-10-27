import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'

// 3.7.12: 0096 deletes the team-room jobs left behind by a run whose room was deleted, and nothing else.

const SRC = fileURLToPath(new URL('../migrations/', import.meta.url))
const at = '2026-10-27T00:00:00.000Z'
let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-0096-'))
  db = openDatabase(join(dir, 'score.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function migrateUpTo(last: string, migrations = join(dir, 'migrations')) {
  mkdirSync(migrations, { recursive: true })
  for (const name of readdirSync(SRC).filter((file) => file.endsWith('.sql')))
    if (name.slice(0, 4) <= last) copyFileSync(join(SRC, name), join(migrations, name))
  migrate(db, migrations)
}

test('a job whose run and run room are gone is deleted with its messages; others are kept', () => {
  migrateUpTo('0095')
  const run = db.sqlite.prepare.bind(db.sqlite)
  for (const [id, name] of [
    ['team', 'Team room'],
    ['room-orc-pruned', 'Orchestration: pruned'],
  ] as const)
    run(
      "INSERT INTO rooms (id, name, kind, members, created_at, updated_at, role, routing) VALUES (?, ?, 'room', '[]', ?, ?, 'room', 'exchanges')",
    ).run(id, name, at, at)
  const job = (id: string, ref: string | null) =>
    run(
      `INSERT INTO jobs (id, room_id, title, session_scheme, recipe_kind, recipe_ref, created_at, updated_at)
       VALUES (?, 'team', ?, 'job', ?, ?, ?, ?)`,
    ).run(id, id, ref ? 'orchestration' : null, ref, at, at)
  job('orphaned', 'orc-gone')
  job('pruned', 'orc-pruned')
  job('plain', null)
  run(
    "INSERT INTO messages (id, room_id, job_id, author_kind, \"to\", parts, refs, streaming, created_at, updated_at) VALUES ('m1', 'team', 'orphaned', 'you', '[]', '[]', '[]', 0, ?, ?)",
  ).run(at, at)
  migrateUpTo('0096')
  const deleted = (id: string) =>
    (run('SELECT deleted_at FROM jobs WHERE id = ?').get(id) as { deleted_at: string | null })
      .deleted_at
  expect(deleted('orphaned')).not.toBeNull()
  expect(deleted('pruned')).toBeNull()
  expect(deleted('plain')).toBeNull()
  expect(
    (run("SELECT deleted_at FROM messages WHERE id = 'm1'").get() as { deleted_at: string | null })
      .deleted_at,
  ).not.toBeNull()
})
