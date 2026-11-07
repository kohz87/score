import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import type { ThemeFs } from '../../src/themes/store.ts'
import {
  asideOld,
  asset,
  db,
  dropOld,
  faulty,
  fileOf,
  leftovers,
  manifest,
  realRename,
  realRm,
  restart,
  setupStoreSwap,
  store,
  withFs,
} from './store-swap-helpers.ts'

setupStoreSwap()

// K2 X14: a delete is a swap whose new folder is nothing: written down first, the folder moved aside, the row removed and
// the note erased together, then the leftover deleted. A stop at any point leaves the theme whole or gone.
describe('removing a theme (K2 X14)', () => {
  beforeEach(() => store.storeImported(manifest('seaside'), 'old', asset('old')))
  const expectKept = () => {
    expect(store.get('seaside')!.css).toBe('old')
    expect(fileOf('seaside')).toBe('old')
    expect(leftovers()).toEqual([])
  }
  const expectGone = () => {
    expect(store.get('seaside')).toBeNull()
    expect(existsSync(join(store.root, 'seaside'))).toBe(false)
    expect(leftovers()).toEqual([])
  }
  const notes = () =>
    (db.sqlite.prepare('SELECT COUNT(*) AS n FROM theme_swaps').get() as { n: number }).n

  test('a failure moving the folder aside changes nothing', () => {
    expect(() => withFs(faulty(asideOld)).remove('seaside')).toThrow(/injected/)
    expectKept()
    expect(notes()).toBe(0)
  })

  test('a failure deleting the row puts the folder back', () => {
    db.sqlite.exec(
      "CREATE TRIGGER block_delete BEFORE DELETE ON themes BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    )
    expect(() => withFs(faulty(() => false)).remove('seaside')).toThrow(/injected/)
    db.sqlite.exec('DROP TRIGGER block_delete')
    expectKept()
    expect(notes()).toBe(0)
  })

  test('the note is committed before the folder moves, and the row goes before the old folder is deleted', () => {
    const seen: string[] = []
    const watching: ThemeFs = {
      rename(from, to) {
        seen.push(`rename:notes=${notes()}:row=${store.get('seaside') ? 1 : 0}`)
        realRename(from, to)
      },
      rm(path) {
        seen.push(`rm:notes=${notes()}:row=${store.get('seaside') ? 1 : 0}`)
        realRm(path, { recursive: true, force: true })
      },
    }
    withFs(watching).remove('seaside')
    // First move: note written, row still there. Deleting the aside folder: row gone and note erased already.
    expect(seen[0]).toBe('rename:notes=1:row=1')
    expect(seen.at(-1)).toBe('rm:notes=0:row=0')
    expectGone()
  })

  test('a stop after the folder moved aside but before the row went: the next start has the whole theme back', () => {
    // The move happens, then the process is gone: nothing else runs (the row delete and the way back both fail).
    let down = false
    const dying: ThemeFs = {
      rename(from, to) {
        if (down) throw new Error('injected: dead')
        realRename(from, to)
        if (asideOld({ op: 'rename', from, to })) {
          down = true
          throw new Error('injected: dead')
        }
      },
      rm() {
        throw new Error('injected: dead')
      },
    }
    expect(() => withFs(dying).remove('seaside')).toThrow(/injected/)
    expect(leftovers().length).toBeGreaterThan(0)
    expect(notes()).toBe(1)
    restart()
    expectKept()
    expect(notes()).toBe(0)
  })

  test('a stop after the row went: the leftover folder is swept and the theme stays gone', () => {
    expect(() => withFs(faulty(dropOld, true)).remove('seaside')).not.toThrow()
    expect(store.get('seaside')).toBeNull()
    expect(leftovers().length).toBeGreaterThan(0)
    restart()
    expectGone()
  })

  test('a folder with no row is swept at start, but a theme in the middle of a note is not', () => {
    mkdirSync(join(store.root, 'ghost/assets/img'), { recursive: true })
    writeFileSync(join(store.root, 'ghost/assets/img/a.png'), 'x')
    mkdirSync(join(store.root, 'pending/assets/img'), { recursive: true })
    db.sqlite
      .prepare(
        "INSERT INTO theme_swaps (token, kind, theme_id, other_id, had_folder, created_at) VALUES ('t', 'swap', 'pending', NULL, 1, 'now')",
      )
      .run()
    store.sweepOrphanFolders()
    expect(existsSync(join(store.root, 'ghost'))).toBe(false)
    expect(existsSync(join(store.root, 'pending'))).toBe(true)
    expect(existsSync(join(store.root, 'seaside'))).toBe(true)
  })

  test('a new theme saved under the id of a deleted theme inherits none of its files', () => {
    // The leftover a crashed delete used to strand.
    mkdirSync(join(store.root, 'ghost/assets/img'), { recursive: true })
    writeFileSync(join(store.root, 'ghost/assets/img/a.png'), 'stale')
    store.saveCustom(manifest('ghost'), 'a{}')
    expect(store.assets('ghost')).toEqual([])
  })
})
