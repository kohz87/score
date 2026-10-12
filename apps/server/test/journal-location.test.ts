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
  homeProvenance,
  journalInsideHome,
  journalRootProblem,
  recordJournalRoot,
} from '../src/journal-location.ts'
import { startServer } from '../src/start-server.ts'

// AA3 (7.7a v5 review #3): the execution journal can never live inside Score's home.

let root: string
let home: string
let xdg: string
let savedXdg: string | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'score-jloc-'))
  home = join(root, 'home')
  mkdirSync(home)
  // The provenance file lives under XDG_STATE_HOME: never the real one.
  xdg = join(root, 'xdg')
  savedXdg = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = xdg
})
afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = savedXdg
  rmSync(root, { recursive: true, force: true })
})

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
  // The provenance outside the home is the authority: a new root is refused even before any journal file exists.
  expect(journalRootProblem(home, join(root, 'new'))).toMatch(/last at/)
  writeFileSync(join(oldRoot, 'journal.ndjson'), '')
  expect(journalRootProblem(home, join(root, 'new'))).toMatch(/last at/)
  expect(journalRootProblem(home, oldRoot)).toBeNull()
})

const script = fileURLToPath(new URL('../../../scripts/restore.mjs', import.meta.url))
const restore = (env: Record<string, string>, backup: string) => {
  try {
    execFileSync('node', [script, backup], {
      env: {
        PATH: process.env.PATH!,
        HOME: root,
        XDG_STATE_HOME: xdg,
        SCORE_HOME: home,
        ...env,
      },
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

// EE3 (7.7a v6 review #3): the journal root is remembered outside the home and outside every root.
test('EE3: backup before the pointer, work under J1, restore, start with J2 is refused', () => {
  const j1 = join(root, 'j1')
  const j2 = join(root, 'j2')
  const backup = join(root, 'backup')
  mkdirSync(backup)
  writeFileSync(join(backup, 'score.db'), 'backup') // taken before any journal-root pointer existed
  writeFileSync(join(home, 'score.db'), 'current')
  recordJournalRoot(home, j1) // the server started with J1 and did work
  mkdirSync(j1)
  writeFileSync(join(j1, 'journal.ndjson'), '')
  const restored = restore({ SCORE_JOURNAL_DIR: j1 }, backup)
  expect(restored.code).toBe(0)
  expect(existsSync(join(home, 'journal-root'))).toBe(false) // the restored home lost its pointer
  expect(journalRootProblem(home, j2)).toMatch(/last at/)
  expect(restore({ SCORE_JOURNAL_DIR: j2 }, backup).err).toMatch(/last at/)
  expect(journalRootProblem(home, j1)).toBeNull()
  expect(process.env.XDG_STATE_HOME).toBe(xdg)
  expect(existsSync(join(xdg, 'score', 'roots.json'))).toBe(true)
  // An explicit confirmation accepts the new root.
  expect(
    journalRootProblem(home, j2, { ...process.env, SCORE_CONFIRM_JOURNAL_ROOT: '1' }),
  ).toBeNull()
})

test('EE3: the provenance records every root with timestamps and survives a pointer-less home', () => {
  recordJournalRoot(home, join(root, 'j1'))
  recordJournalRoot(home, join(root, 'j2'))
  const file = JSON.parse(readFileSync(join(xdg, 'score', 'roots.json'), 'utf8'))
  const entry = Object.values(file.homes)[0] as { current: string; roots: { first: string }[] }
  expect(entry.roots).toHaveLength(2)
  expect(entry.roots[0]!.first).toMatch(/^\d{4}-/)
  expect(entry.current).toMatch(/j2$/)
})

test('EE3: missing or corrupt provenance is reported as such', () => {
  expect(homeProvenance(home).state).toBe('missing')
  mkdirSync(join(xdg, 'score'), { recursive: true })
  writeFileSync(join(xdg, 'score', 'roots.json'), '{nope')
  expect(homeProvenance(home).state).toBe('corrupt')
  recordJournalRoot(home, join(root, 'j1'))
  expect(homeProvenance(home).state).toBe('known')
})
