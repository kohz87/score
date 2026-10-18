import { describe, expect, test } from 'vitest'
import { THEME_CSS_CORPUS } from '@score/contract'
import { sanitiseCss } from './sanitise.ts'

// The browser and the server answer from one allowlist (packages/contract/src/theme-css.ts). This runs the shared
// corpus through the browser's sanitiser: it drops exactly the properties the server refuses
// (apps/server/test/themes/css-allowlist.test.ts is the other half).
function droppedProperties(css: string): string[] {
  const names = sanitiseCss(css).report.dropped.map((item) => {
    const at = /^@([a-z-]+)/i.exec(item.rule)
    if (at) return `@${at[1]!.toLowerCase()}`
    return /\{\s*(--[\w-]+|[a-z-]+)/i.exec(item.rule)?.[1] ?? item.rule
  })
  return [...new Set(names)].sort()
}

// jsdom's own CSS parser loses or rewrites some declarations before the sanitiser sees them (it discards values it
// cannot parse, such as var() and calc() in a colour, and expands `border` with a `border-image` longhand). For those
// the browser may drop fewer properties than listed, never one that is not listed.
const lossyInJsdom = new Set([
  'borders and radius',
  'type metrics',
  'values: var, calc, attr',
  'values: other addresses',
])

describe('the shared corpus, browser side', () => {
  test.each(THEME_CSS_CORPUS.map((item) => [item.name, item] as const))('%s', (_name, item) => {
    const dropped = droppedProperties(item.css)
    if (lossyInJsdom.has(item.name)) {
      if (item.name === 'borders and radius') return
      for (const property of dropped) expect(item.refused).toContain(property)
    } else expect(dropped).toEqual([...item.refused].sort())
  })
})
