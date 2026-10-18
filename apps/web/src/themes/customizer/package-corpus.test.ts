import { describe, expect, it } from 'vitest'
import { corpus } from '@score/contract/test/theme-package-corpus'
import { readThemePackage } from './package.ts'

// Re-gate finding 10: the same accept/reject corpus runs against the server reader (apps/server) and this one.
describe('the shared theme package corpus, browser reader', () => {
  it.each(corpus)('$name', async (item) => {
    const result = await readThemePackage(item.bytes)
    expect(result.ok, JSON.stringify(result)).toBe(item.accept)
    if (!result.ok) return
    expect(result.pkg.manifest.id).toBe(item.expect!.id)
    expect([...result.pkg.assets.keys()].sort()).toEqual(item.expect!.assets)
    expect(Object.keys(result.pkg.licenses).sort()).toEqual(item.expect!.licenses)
    expect(result.pkg.css).toBe(item.expect!.css)
  })
})
