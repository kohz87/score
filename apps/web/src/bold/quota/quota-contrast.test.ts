import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { contrast, declarations } from '../../styles/contrast-pairs.ts'

// The quota bars draw a fill on a track tinted from the ink: each fill keeps 3:1 against it in both looks (graphics, WCAG 1.4.11).
const quotaCss = readFileSync(join(import.meta.dirname, 'bold-quota.css'), 'utf8')
const boldTokens = readFileSync(join(import.meta.dirname, '../tokens.css'), 'utf8')
const DARK = "[data-ui='bold']"
const LIGHT = "[data-ui='bold'][data-look='light']"

function tokens(look: string): Record<string, string> {
  const base = { ...declarations(boldTokens, DARK), ...declarations(quotaCss, DARK) }
  return look === DARK
    ? base
    : { ...base, ...declarations(boldTokens, look), ...declarations(quotaCss, look) }
}

function hex(map: Record<string, string>, name: string): string {
  let value = map[`--${name}`]
  for (let i = 0; i < 4 && value?.startsWith('var('); i += 1) value = map[value.slice(4, -1)]
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--${name} is not a hex colour`)
  return value
}

/** `color-mix(in srgb, var(--ink) 16%, transparent)` over the panel the bar sits on. */
function track(map: Record<string, string>): string {
  const share = Number(/var\(--ink\) (\d+)%/.exec(map['--quota-track'] ?? '')?.[1]) / 100
  const ink = hex(map, 'ink')
  const panel = hex(map, 'panel')
  const mix = [1, 3, 5].map((i) =>
    Math.round(
      parseInt(ink.slice(i, i + 2), 16) * share + parseInt(panel.slice(i, i + 2), 16) * (1 - share),
    )
      .toString(16)
      .padStart(2, '0'),
  )
  return `#${mix.join('')}`
}

for (const [label, look] of [
  ['dark', DARK],
  ['light', LIGHT],
] as const)
  test(`in the ${label} look every quota fill keeps 3:1 against its track`, () => {
    const map = tokens(look)
    const ground = track(map)
    for (const fill of ['quota-ok', 'quota-low', 'quota-bad'])
      expect(contrast(hex(map, fill), ground), `${fill} on the track`).toBeGreaterThanOrEqual(3)
  })

test('the below-floor pill is a light object in both looks, with its own 3:1 pair', () => {
  for (const look of [DARK, LIGHT]) {
    const map = tokens(look)
    expect(
      contrast(hex(map, 'quota-floor-fill'), hex(map, 'quota-floor-track')),
    ).toBeGreaterThanOrEqual(3)
    expect(
      contrast(hex(map, 'quota-floor-ink'), hex(map, 'quota-floor-bg')),
    ).toBeGreaterThanOrEqual(4.5)
  }
})
