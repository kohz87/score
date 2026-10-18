import { describe, expect, test } from 'vitest'
import { THEME_ASSET_PATH } from '@score/contract'
import { corpus } from '@score/contract/test/theme-package-corpus'
import { ASSET_PATH } from '../../src/themes/css-check.ts'
import { ThemeRejected, readThemePackage } from '../../src/themes/package.ts'

// Re-gate finding 10: the same accept/reject corpus runs against the browser reader (apps/web) and this one.
describe('the shared theme package corpus, server reader', () => {
  test.each(corpus)('$name', async (item) => {
    const outcome = await readThemePackage(Buffer.from(item.bytes)).then(
      (pkg) => ({ pkg }),
      (error: unknown) => {
        if (error instanceof ThemeRejected) return { rejected: error.reasons }
        throw error
      },
    )
    if (!item.accept) {
      expect(outcome, 'should be refused').toHaveProperty('rejected')
      return
    }
    expect(outcome, JSON.stringify(outcome)).toHaveProperty('pkg')
    const { pkg } = outcome as { pkg: Awaited<ReturnType<typeof readThemePackage>> }
    expect(pkg.manifest.id).toBe(item.expect!.id)
    expect([...pkg.assets.keys()].sort()).toEqual(item.expect!.assets)
    expect(Object.keys(pkg.licenses).sort()).toEqual(item.expect!.licenses)
    expect(pkg.css).toBe(item.expect!.css)
  })
})

test('the CSS checker and the package rules name assets the same way', () => {
  expect(ASSET_PATH.source).toBe(THEME_ASSET_PATH.source)
})
