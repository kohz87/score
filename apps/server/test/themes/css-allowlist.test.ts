import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { THEME_CSS_CORPUS } from '@score/contract'
import { checkThemeCss } from '../../src/themes/css-check.ts'

// Decision 102, re-gate finding 3: the server refuses what is not on the visual allowlist, naming the property, and it
// refuses exactly what the browser's sanitiser drops (apps/web/src/themes/sanitise.agreement.test.ts runs the same
// corpus against that side).
describe('the shared corpus', () => {
  test.each(THEME_CSS_CORPUS.map((item) => [item.name, item] as const))('%s', (_name, item) => {
    const { reasons } = checkThemeCss(item.css)
    if (item.refused.length === 0) expect(reasons).toEqual([])
    for (const property of item.refused)
      expect(
        reasons.some((reason) => reason.includes(property)),
        `${property} is named in ${JSON.stringify(reasons)}`,
      ).toBe(true)
  })
})

describe('the packages we ship', () => {
  const root = join(import.meta.dirname, '../../../..')
  test.each([
    'apps/server/themes/harbour',
    'apps/server/themes/ledger',
    'apps/server/themes/studio',
    'docs/themes/example-theme',
  ])('%s passes the allowlist', (folder) => {
    expect(checkThemeCss(readFileSync(join(root, folder, 'style.css'), 'utf8')).reasons).toEqual([])
  })
})
