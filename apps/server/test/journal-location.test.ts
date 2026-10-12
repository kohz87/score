import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { loadConfig, resolveJournalDir } from '../src/config.ts'
import {
  journalInsideHome,
  journalRootProblem,
  recordJournalRoot,
} from '../src/journal-location.ts'
import { startServer } from '../src/start-server.ts'

// AA3 (7.7a v5 review #3): the execution journal can never live inside Score's home.

let root: string
let home: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'score-jloc-'))
  home = join(root, 'home')
  mkdirSync(home)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const live = (extra: Record<string, string>) =>
  loadConfig({ SCORE_MODE: 'live', SCORE_HOME: home, HOME: root, ...extra })

test('AA3: a journal directory equal to the home is rejected, naming both paths', () => {
  expect(() => live({ SCORE_JOURNAL_DIR: home })).toThrow(/must be outside/)
  try {
    live({ SCORE_JOURNAL_DIR: home })
  } catch (error) {
    expect(String(error)).toContain(home)
  }
})

test('AA3: a nested journal directory (not created yet) is rejected', () => {
  expect(() => live({ SCORE_JOURNAL_DIR: join(home, 'history', 'deep') })).toThrow(
    /outside the Score home/,
  )
})

test('AA3: a symlink alias into the home is rejected', () => {
  const alias = join(root, 'alias')
  symlinkSync(home, alias)
  expect(() => live({ SCORE_JOURNAL_DIR: join(alias, 'history') })).toThrow(
    /outside the Score home/,
  )
  // A home reached through a link is the same home.
  const homeLink = join(root, 'home-link')
  symlinkSync(home, homeLink)
  expect(() =>
    loadConfig({ SCORE_MODE: 'live', SCORE_HOME: homeLink, SCORE_JOURNAL_DIR: join(home, 'j') }),
  ).toThrow(/outside the Score home/)
})

test('AA3: an XDG_STATE_HOME default that lands inside the home is rejected', () => {
  expect(() => live({ XDG_STATE_HOME: join(home, 'state') })).toThrow(/outside the Score home/)
  expect(
    resolveJournalDir({ mode: 'live', home }, { XDG_STATE_HOME: join(home, 'state') }),
  ).toContain(home)
})

test('AA3: a journal beside the home, or a sibling whose name starts like it, is fine', () => {
  expect(() => live({ SCORE_JOURNAL_DIR: join(root, 'journal') })).not.toThrow()
  expect(journalInsideHome(`${home}-journal`, home)).toBeNull()
})

test('AA3: startServer refuses before creating a lock, marker or journal', async () => {
  const config = {
    ...live({ SCORE_JOURNAL_DIR: join(root, 'ok') }),
    journalDir: join(home, 'history'),
  }
  await expect(startServer(config, { logger: false })).rejects.toThrow(/outside the Score home/)
  expect(existsSync(join(home, 'history'))).toBe(false)
  expect(existsSync(join(home, 'score.db'))).toBe(false)
})

test('AA3: changing the journal root while a journal exists at the old root is refused', () => {
  const oldRoot = join(root, 'old')
  mkdirSync(oldRoot)
  recordJournalRoot(home, oldRoot)
  expect(journalRootProblem(home, oldRoot)).toBeNull()
  expect(journalRootProblem(home, join(root, 'new'))).toBeNull() // nothing at the old root to forget
  writeFileSync(join(oldRoot, 'journal.ndjson'), '')
  expect(journalRootProblem(home, join(root, 'new'))).toMatch(/journal is at/)
  expect(journalRootProblem(home, oldRoot)).toBeNull()
})

const script = fileURLToPath(new URL('../../../scripts/restore.mjs', import.meta.url))
const restore = (env: Record<string, string>, backup: string) => {
  try {
    execFileSync('node', [script, backup], {
      env: { PATH: process.env.PATH!, HOME: root, SCORE_HOME: home, ...env },
      stdio: 'pipe',
    })
    return { code: 0, err: '' }
  } catch (error) {
    const e = error as { status: number; stderr: Buffer }
    return { code: e.status, err: e.stderr.toString() }
  }
}

test('AA3: restore refuses an in-home journal before writing a marker or moving the home', () => {
  const backup = join(root, 'backup')
  mkdirSync(backup)
  writeFileSync(join(backup, 'score.db'), 'backup')
  writeFileSync(join(home, 'score.db'), 'current')
  for (const journalDir of [join(home, 'history'), join(root, 'alias', 'history')]) {
    symlinkSync(home, join(root, 'alias'))
    const result = restore({ SCORE_JOURNAL_DIR: journalDir }, backup)
    rmSync(join(root, 'alias'), { force: true })
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/must be outside the Score home/)
    expect(readFileSync(join(home, 'score.db'), 'utf8')).toBe('current')
    expect(existsSync(join(home, 'history'))).toBe(false)
    expect(existsSync(`${home}.before-restore-`)).toBe(false)
  }
  const ok = restore({ SCORE_JOURNAL_DIR: join(root, 'journal') }, backup)
  expect(ok.code).toBe(0)
  expect(existsSync(join(root, 'journal', 'restore-marker.json'))).toBe(true)
})
