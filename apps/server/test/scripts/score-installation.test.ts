import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { readHomeInstallation, readRegistry, resolveInstallation } from '../../src/installation.ts'
import { openMigrated } from '../orchestration/harness-db.ts'

// `score installation …` (7.7a §2): the way a moved or copied home is confirmed.

const launcher = fileURLToPath(new URL('../../../../scripts/score', import.meta.url))
let root: string
let journalDir: string
let home: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'score-instcli-'))
  journalDir = join(root, 'journal')
  home = join(root, 'home')
  mkdirSync(home)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const envFor = (h: string) => ({
  PATH: process.env.PATH!,
  HOME: root,
  SCORE_HOME: h,
  SCORE_JOURNAL_DIR: journalDir,
})

test('confirm-move and confirm-copy through the launcher; status shows what each side says', () => {
  const first = resolveInstallation({ journalDir, home })
  if (!first.ok) throw new Error(first.message)
  const copy = join(root, 'copy')
  cpSync(home, copy, { recursive: true })
  expect(resolveInstallation({ journalDir, home: copy })).toMatchObject({
    ok: false,
    code: 'unconfirmed_path',
  })
  const status = execFileSync(launcher, ['installation', 'status'], {
    env: envFor(copy),
    encoding: 'utf8',
  })
  expect(status).toContain(`Home says: ${first.id}`)
  expect(status).toContain('Registry says: no entry for this folder')

  const output = execFileSync(launcher, ['installation', 'confirm-copy'], {
    env: envFor(copy),
    encoding: 'utf8',
  })
  expect(output).toContain('copied from')
  const registered = readHomeInstallation(copy)
  expect(registered.state === 'ok' && registered.id).not.toBe(first.id)
  const registry = readRegistry(journalDir)
  expect(registry.state === 'ok' && Object.keys(registry.installations)).toHaveLength(2)

  const moved = join(root, 'moved')
  cpSync(home, moved, { recursive: true })
  rmSync(home, { recursive: true })
  execFileSync(launcher, ['installation', 'confirm-move'], { env: envFor(moved), encoding: 'utf8' })
  expect(resolveInstallation({ journalDir, home: moved })).toMatchObject({ ok: true, id: first.id })
})

test('refuses while Score runs on the home, with bad usage, and for a home with no installation file', () => {
  resolveInstallation({ journalDir, home })
  writeFileSync(join(home, 'score.pid'), String(process.pid))
  const running = spawnSync(launcher, ['installation', 'confirm-move'], {
    env: envFor(home),
    encoding: 'utf8',
  })
  expect(running.status).toBe(1)
  expect(running.stderr).toContain('Score is running')
  expect(
    spawnSync(launcher, ['installation', 'bogus'], { env: envFor(home), encoding: 'utf8' }).status,
  ).toBe(1)
  const bare = join(root, 'bare')
  mkdirSync(bare)
  const none = spawnSync(launcher, ['installation', 'confirm-move'], {
    env: envFor(bare),
    encoding: 'utf8',
  })
  expect(none.status).toBe(1)
  expect(none.stderr).toContain('nothing to confirm')
})

test('FV #1: reset-history asks first, refuses while Score runs, and then retires everything and leaves a fresh journal', () => {
  const first = resolveInstallation({ journalDir, home })
  if (!first.ok) throw new Error(first.message)
  const copy = join(root, 'copy')
  cpSync(home, copy, { recursive: true })
  execFileSync(launcher, ['installation', 'confirm-copy'], { env: envFor(copy), encoding: 'utf8' })
  const id = readHomeInstallation(copy)
  if (id.state !== 'ok') throw new Error('no installation file')
  const database = openMigrated(copy)
  database.sqlite
    .prepare(
      `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
       VALUES ('i1', 'start_coding_run', 't1', '{}', 'pending', 'x', 'x')`,
    )
    .run()
  database.sqlite.prepare("UPDATE orc_global SET frozen_reason = 'a copy', fenced = 1").run()
  database.close()

  // No terminal and no --yes: it asks, so a script can't reset by accident.
  const asked = spawnSync(launcher, ['installation', 'reset-history'], {
    env: envFor(copy),
    encoding: 'utf8',
    input: '',
  })
  expect(asked.status).toBe(1)
  expect(asked.stderr).toContain('--yes')
  writeFileSync(join(copy, 'score.pid'), String(process.pid))
  const running = spawnSync(launcher, ['installation', 'reset-history', '--yes'], {
    env: envFor(copy),
    encoding: 'utf8',
  })
  expect(running.status).toBe(1)
  expect(running.stderr).toContain('Score is running')
  rmSync(join(copy, 'score.pid'))
  const unchanged = new DatabaseSync(join(copy, 'score.db'), { readOnly: true })
  expect(unchanged.prepare("SELECT state FROM command_intents WHERE id = 'i1'").get()).toEqual({
    state: 'pending',
  })
  unchanged.close()

  const done = spawnSync(launcher, ['installation', 'reset-history', '--yes'], {
    env: envFor(copy),
    encoding: 'utf8',
  })
  expect(done.stderr).toBe('')
  expect(done.status).toBe(0)
  expect(done.stdout).toContain('History reset')
  const after = new DatabaseSync(join(copy, 'score.db'), { readOnly: true })
  expect(after.prepare("SELECT state FROM command_intents WHERE id = 'i1'").get()).toEqual({
    state: 'failed',
  })
  expect(after.prepare('SELECT frozen_reason, fenced FROM orc_global').get()).toEqual({
    frozen_reason: null,
    fenced: 0,
  })
  after.close()
  const files = readdirSync(join(journalDir, id.id))
  expect(files.some((name) => name.startsWith('history-before-reset-'))).toBe(true)
  expect(existsSync(join(journalDir, id.id, 'journal.ndjson'))).toBe(true)
  // An unresolved home is not something a history reset can fix.
  const stray = join(root, 'stray')
  cpSync(home, stray, { recursive: true })
  const refused = spawnSync(launcher, ['installation', 'reset-history', '--yes'], {
    env: envFor(stray),
    encoding: 'utf8',
  })
  expect(refused.status).toBe(1)
  expect(refused.stderr).toMatch(/confirm-copy/)
})
