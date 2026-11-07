import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ZodError } from 'zod'
import { hermesPaths } from '../../../src/hermes/live/index.ts'
import { fixtures, installSqliteHooks } from './sqlite-helpers.ts'

installSqliteHooks()

test('paths select the default and named profiles', () => {
  const paths = hermesPaths(fixtures.home)
  expect(paths.kanbanDb).toBe(join(fixtures.home, 'kanban.db'))
  expect(paths.stateDb('default')).toBe(join(fixtures.home, 'state.db'))
  expect(paths.stateDb('builder')).toBe(join(fixtures.home, 'profiles/builder/state.db'))
  expect(paths.stateDb('a'.repeat(64))).toBe(
    join(fixtures.home, 'profiles', 'a'.repeat(64), 'state.db'),
  )
})

test.each([
  '',
  '..',
  '../builder',
  '/tmp/builder',
  'a/b',
  'a\\b',
  'Builder',
  '_builder',
  '-builder',
  'a'.repeat(65),
  'builder\n',
])('rejects invalid profile name %j', (profile) => {
  expect(() => hermesPaths(fixtures.home).stateDb(profile)).toThrow(ZodError)
})

test('the Hermes home defaults to ~/.hermes inside the adapter', async () => {
  const { resolveHermesHome } = await import('../../../src/hermes/live/paths.ts')
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  expect(resolveHermesHome()).toBe(join(homedir(), '.hermes'))
  expect(resolveHermesHome('/srv/hermes')).toBe('/srv/hermes')
})

test('incarnation is stable across writes and changes only when the file is replaced', async () => {
  const { mkdtempSync, renameSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const { incarnationOf } = await import('../../../src/hermes/live/sqlite.ts')
  const dir = mkdtempSync(join(tmpdir(), 'score-incarnation-'))
  try {
    const path = join(dir, 'state.db')
    const writer = new DatabaseSync(path)
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const before = incarnationOf(path)
    for (let i = 0; i < 20; i++) writer.prepare('INSERT INTO t (v) VALUES (?)').run(`row ${i}`)
    writer.close()
    expect(incarnationOf(path)).toBe(before)
    const replacement = new DatabaseSync(join(dir, 'next.db'))
    replacement.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    replacement.close()
    renameSync(join(dir, 'next.db'), path)
    expect(incarnationOf(path)).not.toBe(before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
