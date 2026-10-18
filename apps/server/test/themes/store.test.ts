import { mkdtempSync, rmSync, statSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ThemeManifestSchema } from '@score/contract'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { readLook, resetLook, writeLook } from '../../src/themes/look.ts'
import { ThemeStore } from '../../src/themes/store.ts'

let home: string
let db: ScoreDb
let store: ThemeStore
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'score-themes-'))
  db = openDatabase(join(home, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  store = new ThemeStore(db, home)
})
afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})
const manifest = (id: string, extra: object = {}) =>
  ThemeManifestSchema.parse({ format: 1, id, name: id.toUpperCase(), ...extra })

test('migration 0072 creates the themes table and the look defaults', () => {
  const table = db.sqlite.prepare("SELECT name FROM sqlite_schema WHERE name = 'themes'").get()
  expect(table).toBeDefined()
  expect(readLook(db.sqlite)).toEqual({ activeTheme: 'score', mode: 'system' })
  expect(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'look.mode'").get()).toEqual({
    value: 'system',
  })
})

test('built-ins come from constants and shipped packages: listed first, no rows', () => {
  const items = store.list()
  expect(items.map((item) => [item.id, item.source, item.hasCss])).toEqual([
    ['score', 'builtin', false],
    ['paper', 'builtin', false],
    ['night', 'builtin', false],
    ['dense', 'builtin', false],
    ['harbour', 'builtin', true],
    ['ledger', 'builtin', true],
    ['studio', 'builtin', true],
  ])
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM themes').get()).toEqual({ n: 0 })
  expect(store.detail('night')).toMatchObject({ css: '', assets: [] })
})

test('an imported theme keeps its assets in 0700/0600 folders and disappears with its folder', () => {
  const assets = new Map([['img/bg.webp', Buffer.from('x')]])
  store.storeImported(manifest('seaside'), 'a{color:red}', assets)
  expect(store.list().map((item) => item.id)).toContain('seaside')
  expect(store.assets('seaside')).toEqual(['img/bg.webp'])
  expect(statSync(join(store.root, 'seaside')).mode & 0o777).toBe(0o700)
  expect(statSync(join(store.root, 'seaside/assets/img')).mode & 0o777).toBe(0o700)
  expect(statSync(join(store.root, 'seaside/assets/img/bg.webp')).mode & 0o777).toBe(0o600)
  // Replacing swaps the whole folder.
  store.storeImported(manifest('seaside'), '', new Map())
  expect(store.assets('seaside')).toEqual([])
  store.remove('seaside')
  expect(store.get('seaside')).toBeNull()
  expect(existsSync(join(store.root, 'seaside'))).toBe(false)
})

test('a symlink planted in an asset folder is never listed', () => {
  store.storeImported(manifest('seaside'), '', new Map([['img/a.png', Buffer.from('x')]]))
  symlinkSync('/etc/hostname', join(store.root, 'seaside/assets/img/link.png'))
  expect(store.assets('seaside')).toEqual(['img/a.png'])
})

test('the etag changes with the manifest and with the CSS', () => {
  store.saveCustom(manifest('mine'), '')
  const first = store.detail('mine')!.etag
  store.saveCustom(manifest('mine'), 'a{color:red}')
  const second = store.detail('mine')!.etag
  store.saveCustom(manifest('mine', { description: 'x' }), 'a{color:red}')
  expect(new Set([first, second, store.detail('mine')!.etag]).size).toBe(3)
})

test('look settings round-trip and a damaged row falls back to the default', () => {
  writeLook(db.sqlite, { activeTheme: 'paper', mode: 'dark' })
  expect(readLook(db.sqlite)).toEqual({ activeTheme: 'paper', mode: 'dark' })
  db.sqlite.prepare("UPDATE meta SET value = '../x' WHERE key = 'look.activeTheme'").run()
  expect(readLook(db.sqlite)).toEqual({ activeTheme: 'score', mode: 'system' })
  writeLook(db.sqlite, { activeTheme: 'night', mode: 'light' })
  resetLook(db.sqlite)
  expect(readLook(db.sqlite)).toEqual({ activeTheme: 'score', mode: 'system' })
})

test('a failed row write brings the previous asset folder back', () => {
  store.storeImported(manifest('seaside'), '', new Map([['img/a.png', Buffer.from('x')]]))
  db.sqlite.exec('DROP TABLE themes')
  expect(() => store.storeImported(manifest('seaside'), '', new Map())).toThrow()
  expect(existsSync(join(store.root, 'seaside/assets/img/a.png'))).toBe(true)
})
