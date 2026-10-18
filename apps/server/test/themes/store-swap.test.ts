import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ThemeManifestSchema } from '@score/contract'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { ThemeLockedError, ThemeStore, type ThemeFs } from '../../src/themes/store.ts'
import { rmSync as realRm, renameSync as realRename } from 'node:fs'

// Gate findings #11 and #12: every step of a folder swap and of an id move can fail, or the process can stop between
// two steps. The theme must end up either wholly old or wholly new, and a restart must finish or undo what stopped.
let home: string
let db: ScoreDb
let store: ThemeStore
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'score-swap-'))
  db = openDatabase(join(home, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  store = new ThemeStore(db, home)
})
afterEach(() => {
  db.close()
  rmSync(home, { recursive: true, force: true })
})
const manifest = (id: string) => ThemeManifestSchema.parse({ format: 1, id, name: id })
const asset = (text: string) => new Map([['img/a.png', Buffer.from(text)]])
const fileOf = (id: string) => readFileSync(join(store.root, id, 'assets/img/a.png'), 'utf8')
const leftovers = () => readdirSync(store.root).filter((name) => name.startsWith('.'))

type Op = { op: 'rename' | 'rm'; from: string; to?: string }
/** File moves that throw when `fails` says so; with `dead`, every move after the first failure throws too (a crash). */
function faulty(fails: (op: Op) => boolean, dead = false): ThemeFs {
  let down = false
  const gate = (op: Op) => {
    if (down || fails(op)) {
      if (dead) down = true
      throw new Error(`injected failure: ${op.op} ${basename(op.from)}`)
    }
  }
  return {
    rename(from, to) {
      gate({ op: 'rename', from, to })
      realRename(from, to)
    },
    rm(path) {
      gate({ op: 'rm', from: path })
      realRm(path, { recursive: true, force: true })
    },
  }
}
const asideOld = (op: Op) => op.op === 'rename' && basename(op.to!).startsWith('.old-')
const intoPlace = (op: Op) => op.op === 'rename' && basename(op.from).startsWith('.staging-')
const dropOld = (op: Op) => op.op === 'rm' && basename(op.from).startsWith('.old-')
const withFs = (fs: ThemeFs) => new ThemeStore(db, home, undefined, fs)
const rowSource = (id: string) =>
  (
    db.sqlite.prepare('SELECT source FROM themes WHERE id = ?').get(id) as
      { source: string } | undefined
  )?.source ?? null
const restart = () => {
  const fresh = new ThemeStore(db, home)
  fresh.recoverInterrupted()
  return fresh
}
const blockRowWrites = () =>
  db.sqlite.exec(
    `CREATE TRIGGER block_themes BEFORE UPDATE ON themes BEGIN SELECT RAISE(ABORT, 'injected'); END;
     CREATE TRIGGER block_themes_new BEFORE INSERT ON themes BEGIN SELECT RAISE(ABORT, 'injected'); END;`,
  )
const unblockRowWrites = () =>
  db.sqlite.exec('DROP TRIGGER block_themes; DROP TRIGGER block_themes_new;')

describe('replacing an installed theme (#11)', () => {
  beforeEach(() => store.storeImported(manifest('seaside'), 'old', asset('old')))
  const expectOld = () => {
    expect(store.get('seaside')!.css).toBe('old')
    expect(store.assets('seaside')).toEqual(['img/a.png'])
    expect(fileOf('seaside')).toBe('old')
    expect(leftovers()).toEqual([])
  }
  const expectNew = () => {
    expect(store.get('seaside')!.css).toBe('new')
    expect(fileOf('seaside')).toBe('new')
    expect(leftovers()).toEqual([])
  }
  const replace = (fs: ThemeFs) =>
    withFs(fs).storeImported(manifest('seaside'), 'new', asset('new'))

  test('a failure moving the old folder aside changes nothing', () => {
    expect(() => replace(faulty(asideOld))).toThrow(/injected/)
    expectOld()
  })

  test('a failure moving the new folder into place puts the old one back', () => {
    expect(() => replace(faulty(intoPlace))).toThrow(/injected/)
    expectOld()
  })

  test('a failure writing the row puts the old one back', () => {
    blockRowWrites()
    expect(() => replace(faulty(() => false))).toThrow(/injected/)
    unblockRowWrites()
    expectOld()
  })

  test('if even the way back fails, the next start restores the old folder', () => {
    expect(() => replace(faulty(intoPlace, true))).toThrow(/injected/)
    expect(store.assets('seaside')).toEqual([]) // stranded, as the gate review reproduced
    expect(restart().assets('seaside')).toEqual(['img/a.png'])
    expectOld()
    // Running it again, or a later replace, is harmless.
    restart()
    expectOld()
    store.storeImported(manifest('seaside'), 'new', asset('new'))
    restart()
    expectNew()
  })

  test('a stop after the new folder is in place but before the row commits restores the old folder', () => {
    blockRowWrites()
    expect(() =>
      replace(faulty((op) => op.op === 'rm' && basename(op.from) === 'seaside', true)),
    ).toThrow(/injected/)
    unblockRowWrites()
    expect(fileOf('seaside')).toBe('new') // new files, old row: the inconsistent state
    restart()
    expectOld()
  })

  test('a stop after the commit keeps the new theme and only sweeps the leftovers', () => {
    expect(() => replace(faulty(dropOld, true))).not.toThrow()
    expect(leftovers().length).toBeGreaterThan(0)
    restart()
    expectNew()
  })

  test('stray staging folders are swept at start', () => {
    mkdirSync(join(store.root, '.staging-dead'), { recursive: true })
    writeFileSync(join(store.root, '.staging-dead/x'), 'x')
    restart()
    expectOld()
  })
})

describe('installing a new theme (#11)', () => {
  const expectNothing = () => {
    expect(store.get('seaside')).toBeNull()
    expect(existsSync(join(store.root, 'seaside'))).toBe(false)
    expect(leftovers()).toEqual([])
  }

  test('a failure moving the folder into place leaves nothing', () => {
    expect(() =>
      withFs(faulty(intoPlace)).storeImported(manifest('seaside'), '', asset('new')),
    ).toThrow(/injected/)
    expectNothing()
  })

  test('a stop after the folder is in place but before the row commits removes the folder at start', () => {
    blockRowWrites()
    expect(() =>
      withFs(faulty((op) => op.op === 'rm' && basename(op.from) === 'seaside', true)).storeImported(
        manifest('seaside'),
        '',
        asset('new'),
      ),
    ).toThrow(/injected/)
    unblockRowWrites()
    expect(existsSync(join(store.root, 'seaside'))).toBe(true)
    restart()
    expectNothing()
  })

  test('a custom theme that had no folder gets its row back, not the staged folder', () => {
    store.saveCustom(manifest('seaside'), 'custom')
    blockRowWrites()
    expect(() =>
      withFs(faulty((op) => op.op === 'rm' && basename(op.from) === 'seaside', true)).storeImported(
        manifest('seaside'),
        'imported',
        asset('new'),
      ),
    ).toThrow(/injected/)
    unblockRowWrites()
    restart()
    expect(store.get('seaside')).toMatchObject({ css: 'custom', source: 'custom' })
    expect(store.assets('seaside')).toEqual([])
  })
})

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
