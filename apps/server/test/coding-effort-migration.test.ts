import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'

// 3.9.0: 0098 adds coding_agents.effort; existing agents keep NULL (Default).
const SRC = fileURLToPath(new URL('../migrations/', import.meta.url))
let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-0098-'))
  db = openDatabase(join(dir, 'score.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function migrateUpTo(last: string) {
  const migrations = join(dir, 'migrations')
  mkdirSync(migrations, { recursive: true })
  for (const name of readdirSync(SRC).filter((file) => file.endsWith('.sql')))
    if (name.slice(0, 4) <= last) copyFileSync(join(SRC, name), join(migrations, name))
  migrate(db, migrations)
}

test('existing coding agents get a NULL effort', () => {
  migrateUpTo('0097')
  db.sqlite
    .prepare(
      "INSERT INTO coding_agents (id, name, role, runtime, workspace, permission, color, shape, created_at) VALUES ('c', 'C', '', 'codex', '/w', 'read-only', '#112233', 'hexagon', '2026-10-27T00:00:00.000Z')",
    )
    .run()
  migrateUpTo('0098')
  const row = db.sqlite.prepare("SELECT effort FROM coding_agents WHERE id = 'c'").get() as {
    effort: string | null
  }
  expect(row.effort).toBeNull()
})
