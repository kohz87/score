import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { ThemeLockedError } from '../../src/themes/store.ts'
import {
  asset,
  blockRowWrites,
  db,
  faulty,
  fileOf,
  intoPlace,
  leftovers,
  manifest,
  restart,
  rowSource,
  setupStoreSwap,
  store,
  unblockRowWrites,
  withFs,
} from './store-swap-helpers.ts'

setupStoreSwap()

describe('moving a theme to a free id (#12)', () => {
  const harbour = () => {
    store.storeImported(manifest('harbour'), '', asset('harbour picture'))
    // An orphan folder somebody left behind under the id the move would like to take first.
    mkdirSync(join(store.root, 'harbour-mine/assets/img'), { recursive: true })
    writeFileSync(join(store.root, 'harbour-mine/assets/img/a.png'), 'unrelated')
  }

  test('a stop after the folder moved is finished with the id that was chosen, not one guessed from folders', () => {
    harbour()
    blockRowWrites()
    // Moves the folder to harbour-mine-2, then the row write fails and nothing can move it back.
    const crashing = withFs(
      faulty((op) => op.op === 'rename' && basename(op.from) !== 'harbour', true),
    )
    expect(() => crashing.reclaimBuiltinIds()).toThrow(/injected|themes/)
    unblockRowWrites()
    expect(existsSync(join(store.root, 'harbour-mine-2'))).toBe(true)

    const fresh = restart()
    expect(fresh.reclaimBuiltinIds()).toEqual([])
    expect(fresh.get('harbour-mine-2')).toMatchObject({ source: 'imported' })
    // The folder that goes with the moved theme is the one it owned, not the orphan that sat under the first free id.
    expect(readFileSync(join(store.root, 'harbour-mine-2/assets/img/a.png'), 'utf8')).toBe(
      'harbour picture',
    )
    expect(fileOf('harbour-mine')).toBe('unrelated')
    expect(fresh.get('harbour-mine')).toBeNull()
    expect(rowSource('harbour')).toBeNull() // moved off the built-in id
    expect(fresh.get('harbour')!.source).toBe('builtin')
  })

  test('an orphan folder is never taken for a theme that has no folder of its own', () => {
    store.saveCustom(manifest('studio'), 'x{color:red}')
    mkdirSync(join(store.root, 'studio-mine/assets/img'), { recursive: true })
    writeFileSync(join(store.root, 'studio-mine/assets/img/a.png'), 'unrelated')
    expect(store.reclaimBuiltinIds()).toEqual([{ from: 'studio', to: 'studio-mine-2' }])
    expect(store.assets('studio-mine-2')).toEqual([])
    expect(store.get('studio-mine')).toBeNull()
  })

  test('a folder that fails to move leaves the theme as it was, to be retried', () => {
    harbour()
    expect(() => withFs(faulty((op) => op.op === 'rename')).reclaimBuiltinIds()).not.toThrow()
    expect(rowSource('harbour')).toBe('imported')
    expect(readdirSync(join(store.root, 'harbour'))).toEqual(['assets'])
    expect(store.reclaimBuiltinIds()).toEqual([{ from: 'harbour', to: 'harbour-mine-2' }])
    expect(store.assets('harbour-mine-2')).toEqual(['img/a.png'])
  })

  test('a stop before the folder moved is redone from scratch at the next start', () => {
    harbour()
    // Journal written, then nothing could move.
    const stopped = withFs(faulty((op) => op.op === 'rename', true))
    stopped.reclaimBuiltinIds()
    const fresh = restart()
    expect(fresh.reclaimBuiltinIds()).toEqual([{ from: 'harbour', to: 'harbour-mine-2' }])
    expect(fresh.assets('harbour-mine-2')).toEqual(['img/a.png'])
    expect(fileOf('harbour-mine')).toBe('unrelated')
  })
})

// Re-gate finding 2: a note that recovery could not settle still stands for an old folder that will be put back. Until
// it is settled nothing else may write that id, or the later recovery would put an old folder under a newer row.
describe('an unsettled note blocks its id (re-gate #2)', () => {
  const brokenReplace = () => {
    store.storeImported(manifest('seaside'), 'A', asset('A'))
    // B fails to land and the way back fails too: A's folder stays aside under .old-*.
    expect(() =>
      withFs(faulty(intoPlace, true)).storeImported(manifest('seaside'), 'B', asset('B')),
    ).toThrow(/injected/)
  }
  const recoveryDown = () =>
    faulty((op) => op.op === 'rename' && basename(op.from).startsWith('.old-'))

  test('a retry that runs before recovery succeeds is refused, and the later recovery restores A whole', () => {
    brokenReplace()
    expect(() =>
      withFs(recoveryDown()).storeImported(manifest('seaside'), 'C', asset('C')),
    ).toThrow(/put back|recover/i)
    expect(store.get('seaside')!.css).toBe('A')
    restart()
    expect(store.get('seaside')!.css).toBe('A')
    expect(fileOf('seaside')).toBe('A')
    expect(leftovers()).toEqual([])
    // Once recovery succeeded, the id is free again.
    store.storeImported(manifest('seaside'), 'C', asset('C'))
    expect(store.get('seaside')!.css).toBe('C')
    expect(fileOf('seaside')).toBe('C')
  })

  test('deleting the id is refused too, instead of leaving A’s folder to come back without a row', () => {
    brokenReplace()
    expect(() => withFs(recoveryDown()).remove('seaside')).toThrow(/put back|recover/i)
    expect(store.get('seaside')).not.toBeNull()
    restart()
    expect(fileOf('seaside')).toBe('A')
  })

  test('a custom save of the id is refused as well', () => {
    brokenReplace()
    expect(() => withFs(recoveryDown()).saveCustom(manifest('seaside'), 'X')).toThrow(
      /put back|recover/i,
    )
  })

  test('other ids are not held up', () => {
    brokenReplace()
    withFs(recoveryDown()).storeImported(manifest('other'), 'O', asset('O'))
    expect(store.get('other')!.css).toBe('O')
  })

  test('reclaiming a built-in id leaves a row alone while its note is unsettled, then moves it', () => {
    store.storeImported(manifest('harbour'), '', asset('harbour picture'))
    // The move planned harbour -> harbour-mine; the folder moved, the row write failed and nothing could undo it.
    blockRowWrites()
    const crashing = withFs(
      faulty((op) => op.op === 'rename' && basename(op.from) !== 'harbour', true),
    )
    expect(() => crashing.reclaimBuiltinIds()).toThrow()
    unblockRowWrites()
    // Recovery cannot settle that note (erasing it fails), so the row keeps its id and nothing is planned again.
    db.sqlite.exec(
      "CREATE TRIGGER keep_notes BEFORE DELETE ON theme_swaps BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    )
    expect(restart().reclaimBuiltinIds()).toEqual([])
    expect(rowSource('harbour')).toBe('imported')
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM theme_swaps').get()).toEqual({ n: 1 })
    db.sqlite.exec('DROP TRIGGER keep_notes')
    const fresh = restart()
    expect(fresh.reclaimBuiltinIds()).toEqual([])
    expect(rowSource('harbour')).toBeNull()
    expect(fresh.get('harbour-mine')).toMatchObject({ source: 'imported' })
    expect(readFileSync(join(store.root, 'harbour-mine/assets/img/a.png'), 'utf8')).toBe(
      'harbour picture',
    )
  })
})

// Third gate finding 4: reads of an id whose note is unsettled must not mix versions (CSS and etag of A, asset bytes of
// B). They answer ThemeLockedError (409 theme_recovering over HTTP) until recovery settles the id.
describe('reads while a note is unsettled (third gate #4)', () => {
  const recoveryDown = () =>
    faulty((op) => op.op === 'rename' && basename(op.from).startsWith('.old-'))
  beforeEach(() => {
    store.storeImported(manifest('seaside'), 'A', asset('A'))
    // B's files are in place, the row commit failed and the way back is blocked: row A, folder B.
    blockRowWrites()
    expect(() =>
      withFs(faulty(intoPlace, true)).storeImported(manifest('seaside'), 'B', asset('B')),
    ).toThrow(/injected/)
    unblockRowWrites()
  })

  test('the setup really is a mixed state (row A, assets not A)', () => {
    expect(store.get('seaside')!.css).toBe('A')
    expect(store.assets('seaside')).toEqual([])
  })

  test('detail refuses', () => {
    expect(() => withFs(recoveryDown()).detail('seaside')).toThrow(ThemeLockedError)
  })

  test('the asset listing used by export refuses', () => {
    expect(() => withFs(recoveryDown()).assertReadable('seaside')).toThrow(ThemeLockedError)
  })

  test('other ids are still readable', () => {
    withFs(recoveryDown()).storeImported(manifest('other'), 'O', asset('O'))
    expect(withFs(recoveryDown()).detail('other')!.css).toBe('O')
  })

  test('once recovery succeeds the id reads again, wholly A', () => {
    const fresh = restart()
    expect(fresh.detail('seaside')!.css).toBe('A')
    expect(fresh.assets('seaside')).toEqual(['img/a.png'])
    expect(fileOf('seaside')).toBe('A')
  })

  test('a read tries recovery itself, so a transient fault heals on the next read', () => {
    expect(() => withFs(recoveryDown()).detail('seaside')).toThrow(ThemeLockedError)
    expect(store.detail('seaside')!.assets).toEqual(['img/a.png'])
    expect(fileOf('seaside')).toBe('A')
  })
})
