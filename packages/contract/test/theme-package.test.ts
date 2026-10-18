import { describe, expect, test } from 'vitest'
import {
  THEME_ASSET_PATH,
  ThemePackageError,
  extraFieldProblem,
  readZipDirectory,
  reviewPackageContent,
  reviewPackageEntries,
  uploadProblem,
} from '../src/theme-package.ts'
import { ThemeAssetRefSchema } from '../src/themes.ts'
import { corpus } from './theme-package-corpus.ts'
import { buildZip, unicodeCommentExtra, unicodePathExtra } from './theme-package-zip.ts'

// The three layers of the shared package rules, run on the corpus the browser and the server readers also run. Only
// the layers that need no inflating are exercised here (the corpus stores its files).
function verdict(bytes: Uint8Array): { ok: true } | { ok: false; why: string } {
  const upload = uploadProblem(bytes)
  if (upload) return { ok: false, why: upload }
  try {
    const entries = readZipDirectory(bytes)
    const reasons = reviewPackageEntries(entries)
    if (reasons.length > 0) return { ok: false, why: reasons[0]! }
    const files = new Map<string, Uint8Array>()
    for (const entry of entries)
      if (!entry.isDir)
        files.set(entry.name, bytes.subarray(entry.dataStart, entry.dataStart + entry.size))
    const content = reviewPackageContent(files)
    if (content.reasons.length > 0) return { ok: false, why: content.reasons[0]! }
    if (!files.has('theme.json')) return { ok: false, why: 'theme.json is missing' }
    return { ok: true }
  } catch (error) {
    if (error instanceof ThemePackageError) return { ok: false, why: error.message }
    throw error
  }
}

describe('shared theme package rules', () => {
  // Cases the manifest decides (schema, format, referenced assets) are judged by the readers, not by these layers.
  const readerOnly =
    /theme\.json that|a newer format|an asset the manifest names|no theme\.json|stylesheet that is not|manifest over/
  test.each(corpus.filter((item) => !readerOnly.test(item.name)))('$name', (item) => {
    expect(verdict(item.bytes).ok).toBe(item.accept)
  })

  test('extra fields: only a Unicode path field is refused', () => {
    expect(extraFieldProblem(unicodePathExtra('a', 'b'))).toMatch(/Unicode name/)
    expect(extraFieldProblem(unicodeCommentExtra('c'))).toBeNull()
    expect(extraFieldProblem(new Uint8Array())).toBeNull()
    expect(extraFieldProblem(Uint8Array.from([1, 2, 3]))).toMatch(/malformed/)
  })

  test('a zip with no files is refused by the layer that needs a manifest, not by structure', () => {
    expect(readZipDirectory(buildZip([]))).toEqual([])
  })

  test('the asset path rule is the one the manifest schema uses', () => {
    for (const path of [
      'img/a.png',
      'img/../a.png',
      'fonts/a.woff2',
      'fonts/a.png',
      'a.png',
      'img/.a.png',
      'img/a.gif',
    ])
      expect(THEME_ASSET_PATH.test(path), path).toBe(
        ThemeAssetRefSchema.safeParse(`asset:${path}`).success,
      )
  })
})
