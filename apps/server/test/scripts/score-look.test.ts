import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase } from '../../src/db/index.ts'
import { readLook, writeLook } from '../../src/themes/look.ts'

// `scripts/score look reset`: the host escape hatch from a theme that makes Score hard to use.

const launcher = fileURLToPath(new URL('../../../../scripts/score', import.meta.url))
let root: string
let home: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'score-look-cli-'))
  home = join(root, 'home')
  mkdirSync(home)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const env = () => ({ PATH: process.env.PATH!, HOME: root, SCORE_HOME: home })
const generation = () => {
  const db = openDatabase(join(home, 'score.db'))
  try {
    const row = db.sqlite
      .prepare("SELECT value FROM meta WHERE key = 'look.resetGeneration'")
      .get() as { value: string } | undefined
    return row === undefined ? 0 : Number(row.value)
  } finally {
    db.close()
  }
}
const look = () => {
  const db = openDatabase(join(home, 'score.db'))
  try {
    return readLook(db.sqlite)
  } finally {
    db.close()
  }
}

test('reset puts the shared look back to the score theme and the system mode, with Score stopped', () => {
  const db = openDatabase(join(home, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  writeLook(db.sqlite, { activeTheme: 'harbour', mode: 'dark' })
  db.close()
  expect(look()).toEqual({ activeTheme: 'harbour', mode: 'dark' })
  const out = execFileSync(launcher, ['look', 'reset'], { env: env(), encoding: 'utf8' })
  expect(out).toContain('back to the Score theme')
  expect(look()).toEqual({ activeTheme: 'score', mode: 'system' })
  // Running it again changes nothing and still succeeds.
  execFileSync(launcher, ['look', 'reset'], { env: env() })
  expect(look()).toEqual({ activeTheme: 'score', mode: 'system' })
})

test('reset also works on a database that never had the look rows', () => {
  const db = openDatabase(join(home, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  db.sqlite.exec("DELETE FROM meta WHERE key LIKE 'look.%'")
  db.close()
  execFileSync(launcher, ['look', 'reset'], { env: env() })
  expect(look()).toEqual({ activeTheme: 'score', mode: 'system' })
})

test('reset with no database says there is nothing to do and creates no database', () => {
  const out = execFileSync(launcher, ['look', 'reset'], { env: env(), encoding: 'utf8' })
  expect(out).toContain('Nothing to reset')
  expect(existsSync(join(home, 'score.db'))).toBe(false)
})

test('anything but `look reset` is a usage error and changes nothing', () => {
  const db = openDatabase(join(home, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  writeLook(db.sqlite, { activeTheme: 'harbour', mode: 'dark' })
  db.close()
  for (const args of [['look'], ['look', 'nope'], ['look', 'reset', 'extra']]) {
    const result = spawnSync(launcher, args, { env: env(), encoding: 'utf8' })
    expect(result.status, args.join(' ')).toBe(2)
  }
  expect(look()).toEqual({ activeTheme: 'harbour', mode: 'dark' })
})

// Gate finding #10: the shared look alone can't recover a browser that keeps its own override, so each run also bumps
// the reset generation that devices compare against (contract § 16).
test('every reset run bumps the reset generation, even when the shared look was already the default', () => {
  const db = openDatabase(join(home, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  db.close()
  expect(generation()).toBe(0)
  execFileSync(launcher, ['look', 'reset'], { env: env() })
  expect(generation()).toBe(1)
  execFileSync(launcher, ['look', 'reset'], { env: env() })
  expect(generation()).toBe(2)
})
