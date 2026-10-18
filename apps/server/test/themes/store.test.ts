import { mkdtempSync, renameSync, rmSync, statSync, existsSync, symlinkSync } from 'node:fs'
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

test('licence files are stored with an imported theme and survive a save of the same theme', () => {
  store.storeImported(manifest('seaside'), '', new Map(), { 'OFL.txt': 'SIL OFL text\n' })
  expect(store.get('seaside')!.licenses).toEqual({ 'OFL.txt': 'SIL OFL text\n' })
  store.saveCustom(manifest('seaside', { description: 'edited' }), 'a{color:red}')
  expect(store.get('seaside')!.licenses).toEqual({ 'OFL.txt': 'SIL OFL text\n' })
  store.storeImported(manifest('seaside'), '', new Map())
  expect(store.get('seaside')!.licenses).toEqual({})
  // The shipped built-ins carry theirs.
  expect(Object.keys(store.get('ledger')!.licenses)).toEqual(['OFL.txt'])
  expect(Object.keys(store.get('studio')!.licenses)).toEqual(['OFL.txt'])
  expect(store.get('harbour')!.licenses).toEqual({})
})

// Before 9.5 harbour, ledger and studio were free ids: a theme with one of them, installed earlier, must not be
// shadowed by the built-in of the same name after an upgrade.
test('an upgrade moves a theme whose id is now built in to a free id, with its assets and the active look', () => {
  store.storeImported(
    manifest('harbour', { description: 'mine' }),
    'a{background:url(asset:img/a.png)}',
    new Map([['img/a.png', Buffer.from('picture')]]),
    { LICENSE: 'MIT' },
  )
  store.storeImported(manifest('harbour-mine'), '', new Map([['img/b.png', Buffer.from('b')]]))
  store.saveCustom(manifest('ledger'), 'b{color:blue}')
  writeLook(db.sqlite, { activeTheme: 'harbour', mode: 'dark' })
  // The clash, as it is before the fix: two entries called harbour and the built-in answers for the id.
  expect(store.list().filter((item) => item.id === 'harbour')).toHaveLength(2)
  expect(store.get('harbour')!.source).toBe('builtin')

  expect(store.reclaimBuiltinIds()).toEqual([
    { from: 'harbour', to: 'harbour-mine-2' },
    { from: 'ledger', to: 'ledger-mine' },
  ])

  expect(store.list().map((item) => [item.id, item.source])).toEqual([
    ['score', 'builtin'],
    ['paper', 'builtin'],
    ['night', 'builtin'],
    ['dense', 'builtin'],
    ['harbour', 'builtin'],
    ['ledger', 'builtin'],
    ['studio', 'builtin'],
    ['harbour-mine', 'imported'],
    ['harbour-mine-2', 'imported'],
    ['ledger-mine', 'custom'],
  ])
  const moved = store.get('harbour-mine-2')!
  expect(moved.manifest).toMatchObject({ id: 'harbour-mine-2', description: 'mine' })
  expect(moved.css).toBe('a{background:url(asset:img/a.png)}')
  expect(moved.licenses).toEqual({ LICENSE: 'MIT' })
  expect(store.assets('harbour-mine-2')).toEqual(['img/a.png'])
  expect(existsSync(join(store.root, 'harbour'))).toBe(false)
  // The other theme's files are untouched, the built-in is the built-in again, and the look follows.
  expect(store.assets('harbour-mine')).toEqual(['img/b.png'])
  expect(store.detail('harbour')!.manifest.author).toBe('Score')
  expect(store.assets('harbour')).toEqual(['img/harbour.png'])
  expect(readLook(db.sqlite)).toEqual({ activeTheme: 'harbour-mine-2', mode: 'dark' })
  // Nothing is left to do, and the moved theme can be edited and deleted like any other.
  expect(store.reclaimBuiltinIds()).toEqual([])
  store.saveCustom(manifest('ledger-mine'), 'c{color:green}')
  store.remove('ledger-mine')
  expect(store.get('ledger-mine')).toBeNull()
})

test('a move that stopped after the folder moved is finished on the next start', () => {
  store.storeImported(manifest('studio'), '', new Map([['img/a.png', Buffer.from('picture')]]))
  renameSync(join(store.root, 'studio'), join(store.root, 'studio-mine'))
  expect(store.reclaimBuiltinIds()).toEqual([{ from: 'studio', to: 'studio-mine' }])
  expect(store.assets('studio-mine')).toEqual(['img/a.png'])
  expect(store.get('studio-mine')!.source).toBe('imported')
})

test('an active look on a theme that is not affected is left alone', () => {
  store.saveCustom(manifest('mine'), '')
  writeLook(db.sqlite, { activeTheme: 'mine', mode: 'light' })
  expect(store.reclaimBuiltinIds()).toEqual([])
  expect(readLook(db.sqlite)).toEqual({ activeTheme: 'mine', mode: 'light' })
})
