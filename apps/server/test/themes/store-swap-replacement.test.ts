import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import type { ThemeFs } from '../../src/themes/store.ts'
import {
  asideOld,
  asset,
  blockRowWrites,
  dropOld,
  faulty,
  fileOf,
  intoPlace,
  leftovers,
  manifest,
  restart,
  setupStoreSwap,
  store,
  unblockRowWrites,
  withFs,
} from './store-swap-helpers.ts'

setupStoreSwap()

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
