import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { GlobalFenceStore, readGlobal } from '../../src/domain/orchestration/fence.ts'
import { ExecutionJournal, journalScope } from '../../src/domain/orchestration/journal.ts'
import { migrate, openDatabase } from '../../src/db/index.ts'
import { migrationsDir } from '../orchestration/harness-db.ts'

const launcher = fileURLToPath(new URL('../../../../scripts/score', import.meta.url))
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'score-restore-'))
  roots.push(root)
  const home = join(root, 'home')
  const backup = join(root, 'backup')
  const journalDir = join(root, 'journal')
  mkdirSync(backup)
  const seeded = openDatabase(join(backup, 'score.db'))
  migrate(seeded, migrationsDir)
  seeded.close()
  writeFileSync(join(backup, 'note.txt'), 'from the backup')
  mkdirSync(home)
  writeFileSync(join(home, 'score.db'), 'current database')
  const env = {
    PATH: process.env.PATH!,
    HOME: root,
    SCORE_HOME: home,
    SCORE_JOURNAL_DIR: journalDir,
  }
  return { root, home, backup, journalDir, env }
}

test('score restore replaces the home, keeps the old one and leaves a marker the next start turns into a fence', () => {
  const { home, backup, journalDir, env, root } = setup()
  const output = execFileSync(launcher, ['restore', backup], { env, encoding: 'utf8' })
  expect(output).toContain('global admission fence')
  expect(readFileSync(join(home, 'note.txt'), 'utf8')).toBe('from the backup')
  const aside = readdirSync(root).find((name) => name.startsWith('home.before-restore-'))
  expect(aside).toBeDefined()
  expect(readFileSync(join(root, aside!, 'score.db'), 'utf8')).toBe('current database')

  // The next start (here: the fence store on the restored database) fences with the untrusted-history marker.
  const db = openDatabase(join(home, 'score.db'))
  const scope = journalScope(join(root, 'home'))
  const journal = new ExecutionJournal(journalDir, scope)
  const store = new GlobalFenceStore(db, journal)
  expect(store.startupCheck()).toEqual({ fenced: true, reasons: ['restore'] })
  expect(readGlobal(db.sqlite)).toMatchObject({ fenced: 1, untrusted_history: 1 })
  db.close()
})

test('score restore refuses a backup that is not a Score home, a missing folder and a running Score', () => {
  const { home, backup, env, root } = setup()
  const empty = join(root, 'empty')
  mkdirSync(empty)
  expect(spawnSync(launcher, ['restore', empty], { env, encoding: 'utf8' }).status).toBe(1)
  expect(
    spawnSync(launcher, ['restore', join(root, 'nope')], { env, encoding: 'utf8' }).status,
  ).toBe(1)
  expect(spawnSync(launcher, ['restore'], { env, encoding: 'utf8' }).status).toBe(1)
  // A live process in the pid file (this test's own pid) blocks the restore.
  writeFileSync(join(home, 'score.pid'), String(process.pid))
  const result = spawnSync(launcher, ['restore', backup], { env, encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Score is running')
  expect(existsSync(join(env.SCORE_JOURNAL_DIR, 'restore-marker.json'))).toBe(false)
  expect(readFileSync(join(home, 'score.db'), 'utf8')).toBe('current database')
})
