import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ThemeManifestSchema } from '@score/contract'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { ThemeRejected, readThemePackage } from '../../src/themes/package.ts'
import { ThemeStore } from '../../src/themes/store.ts'
import { manifestJson, rawZip } from './helpers.ts'

// Gate finding #1: the central directory names the files a reader previews; the local headers are what JSZip reads.
// A package whose two lists disagree can show one theme and install another.
const reasonsOf = async (bytes: Buffer) => {
  try {
    await readThemePackage(bytes)
  } catch (error) {
    if (error instanceof ThemeRejected) return error.reasons.join('\n')
    throw error
  }
  throw new Error('the package was accepted')
}

const reviewed = manifestJson({ description: 'what was reviewed' })
const swapped = manifestJson({ description: 'what gets installed' })

describe('local headers and the central directory must agree', () => {
  test('a valid hand-written zip is still read', async () => {
    const pkg = await readThemePackage(
      rawZip([
        { name: 'theme.json', data: reviewed },
        { name: 'style.css', data: 'a{color:red}' },
      ]),
    )
    expect(pkg.manifest.description).toBe('what was reviewed')
    expect(pkg.css).toBe('a{color:red}')
  })

  test('swapped names (theme.json and style.css) are refused', async () => {
    const bytes = rawZip([
      { name: 'theme.json', localName: 'style.css', data: reviewed },
      { name: 'style.css', localName: 'theme.json', data: swapped },
    ])
    expect(await reasonsOf(bytes)).toMatch(/don.t match|disagree/i)
  })

  test('a local name that differs from the central one is refused, even when the package would otherwise be valid', async () => {
    const bytes = rawZip([
      { name: 'theme.json', data: reviewed },
      { name: 'style.css', localName: 'LICENSE', data: 'a{color:red}' },
    ])
    expect(await reasonsOf(bytes)).toMatch(/don.t match|disagree/i)
  })

  test('sizes that differ between the local header and the central directory are refused', async () => {
    const bytes = rawZip([{ name: 'theme.json', data: reviewed, localSize: reviewed.length + 5 }])
    expect(await reasonsOf(bytes)).toMatch(/don.t match|disagree/i)
  })

  test('a different method in the local header is refused', async () => {
    const bytes = rawZip([{ name: 'theme.json', data: reviewed, localMethod: 8 }])
    expect(await reasonsOf(bytes)).toMatch(/don.t match|disagree/i)
  })

  test('two entries with the same name are refused (the later one would silently win)', async () => {
    const bytes = rawZip([
      { name: 'theme.json', data: reviewed },
      { name: 'theme.json', data: swapped },
    ])
    expect(await reasonsOf(bytes)).toMatch(/twice|duplicate/i)
  })

  test('a name that differs only in case is a duplicate', async () => {
    const bytes = rawZip([
      { name: 'theme.json', data: reviewed },
      { name: 'Theme.json', data: swapped },
    ])
    expect(await reasonsOf(bytes)).toMatch(/twice|duplicate|not part/i)
  })
})

describe('a crafted package changes no installed theme', () => {
  let home: string
  let db: ScoreDb
  let store: ThemeStore
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'score-zipagree-'))
    db = openDatabase(join(home, 'score.db'))
    migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
    store = new ThemeStore(db, home)
  })
  afterEach(() => {
    db.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('replacing with a package whose headers disagree is rejected before the store is touched', async () => {
    store.storeImported(
      ThemeManifestSchema.parse({ format: 1, id: 'seaside', name: 'Seaside' }),
      'a{color:blue}',
      new Map(),
    )
    const before = store.detail('seaside')
    const attack = rawZip([
      { name: 'theme.json', localName: 'style.css', data: reviewed },
      { name: 'style.css', localName: 'theme.json', data: swapped },
    ])
    await expect(readThemePackage(attack)).rejects.toBeInstanceOf(ThemeRejected)
    expect(store.detail('seaside')).toEqual(before)
  })
})
