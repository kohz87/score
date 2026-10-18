import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ThemeManifestSchema } from '@score/contract'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { ThemeStore, type ThemeFs } from '../../src/themes/store.ts'

// K2 X5: what must be on disk before the next step of a swap. A test can't cut the power, so it records the order of the
// steps (file syncs, folder syncs, the two database commits and their `synchronous` level, the folder moves) with fault
// injection points at each, and checks the order that makes "wholly old or wholly new" hold after a power cut too.
let home: string
let db: ScoreDb
let events: string[]
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'score-durable-'))
  db = openDatabase(join(home, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  events = []
  const plain = db.tx.bind(db)
  // Label each write transaction by the level it ran at and by whether it left a swap note standing (journal) or not.
  db.tx = ((fn: Parameters<typeof plain>[0]) =>
    plain((sqlite) => {
      const result = fn(sqlite)
      const level = (sqlite.prepare('PRAGMA synchronous').get() as { synchronous: number })
        .synchronous
      const notes = (sqlite.prepare('SELECT COUNT(*) AS n FROM theme_swaps').get() as { n: number })
        .n
      events.push(`${notes > 0 ? 'journal' : 'commit'}:sync=${level}`)
      return result
    })) as typeof db.tx
})
afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})
const manifest = (id: string) => ThemeManifestSchema.parse({ format: 1, id, name: id })
const asset = (text: string) => new Map([['img/a.png', Buffer.from(text)]])

function recorder(root: () => string): ThemeFs {
  return {
    rename(from, to) {
      events.push(basename(to).startsWith('.old-') ? 'rename:aside' : 'rename:in')
      renameSync(from, to)
    },
    rm(path) {
      if (basename(path).startsWith('.old-')) events.push('rm:old')
      rmSync(path, { recursive: true, force: true })
    },
    sync(path) {
      events.push(path === root() ? 'sync:root' : 'sync:staged')
    },
  }
}
/** Consecutive repeats collapsed: how many files and folders were synced does not matter, only where. */
const order = () => events.filter((event, i) => event !== events[i - 1])

describe('the order of a swap (K2 X5)', () => {
  const newStore = () =>
    new ThemeStore(
      db,
      home,
      undefined,
      recorder(() => store.root),
    )
  let store: ThemeStore
  beforeEach(() => {
    store = newStore()
  })

  test('a new theme: files synced, then the note durable, then the folder in, then the row durable', () => {
    store.storeImported(manifest('seaside'), '', asset('new'))
    expect(order()).toEqual([
      'sync:staged',
      'journal:sync=2',
      'rename:in',
      'sync:root',
      'commit:sync=2',
      'rm:old', // nothing there to delete, but never before the commit
    ])
  })

  test('a replacement: the old folder is deleted only after the new row is durable', () => {
    store.storeImported(manifest('seaside'), 'old', asset('old'))
    events.length = 0
    store.storeImported(manifest('seaside'), 'new', asset('new'))
    expect(order()).toEqual([
      'sync:staged',
      'journal:sync=2',
      'rename:aside',
      'sync:root',
      'rename:in',
      'sync:root',
      'commit:sync=2',
      'rm:old',
    ])
  })

  test('a delete: the note first, the move synced, the row durable, then the old folder deleted', () => {
    store.storeImported(manifest('seaside'), 'old', asset('old'))
    events.length = 0
    store.remove('seaside')
    expect(order()).toEqual([
      'journal:sync=2',
      'rename:aside',
      'sync:root',
      'commit:sync=2',
      'rm:old',
    ])
  })

  test('an id move: the note durable, the folder moved and synced, then the row durable', () => {
    store.storeImported(manifest('harbour'), '', asset('h'))
    events.length = 0
    store.reclaimBuiltinIds()
    expect(order()).toEqual(['journal:sync=2', 'rename:in', 'sync:root', 'commit:sync=2'])
  })

  test('the connection goes back to its normal level after each durable write', () => {
    store.storeImported(manifest('seaside'), '', asset('new'))
    expect(db.sqlite.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 1 })
  })
})

describe('a sync that fails stops the swap and keeps the old theme (K2 X5)', () => {
  const failing = (when: (path: string, n: number) => boolean): ThemeStore => {
    let n = 0
    return new ThemeStore(db, home, undefined, {
      rename: renameSync,
      rm: (path) => rmSync(path, { recursive: true, force: true }),
      sync(path) {
        n += 1
        if (when(path, n)) throw new Error('injected: EIO')
      },
    })
  }
  const leftovers = () => readdirSync(join(home, 'themes')).filter((name) => name.startsWith('.'))
  const notes = () =>
    (db.sqlite.prepare('SELECT COUNT(*) AS n FROM theme_swaps').get() as { n: number }).n

  test('failing to sync the staged files happens before anything is written down', () => {
    new ThemeStore(db, home).storeImported(manifest('seaside'), 'old', asset('old'))
    const store = failing(() => true)
    expect(() => store.storeImported(manifest('seaside'), 'new', asset('new'))).toThrow(/EIO/)
    expect(notes()).toBe(0)
    expect(store.get('seaside')!.css).toBe('old')
    expect(readFileSync(join(store.root, 'seaside/assets/img/a.png'), 'utf8')).toBe('old')
    expect(leftovers()).toEqual([])
  })

  test('failing to sync after a folder move puts the old folder back', () => {
    new ThemeStore(db, home).storeImported(manifest('seaside'), 'old', asset('old'))
    const store = failing((path) => path === join(home, 'themes'))
    expect(() => store.storeImported(manifest('seaside'), 'new', asset('new'))).toThrow(/EIO/)
    expect(notes()).toBe(0)
    expect(store.get('seaside')!.css).toBe('old')
    expect(readFileSync(join(store.root, 'seaside/assets/img/a.png'), 'utf8')).toBe('old')
    expect(leftovers()).toEqual([])
  })
})
