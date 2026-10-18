import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ThemeManifestSchema } from '@score/contract'
import { BUILTIN_THEMES_DIR } from '../../src/themes/builtin.ts'
import { HARBOUR, SAND, renderHarbour, renderSand, themeArt } from '../../scripts/theme-art.ts'

const ROOT = join(BUILTIN_THEMES_DIR, '../../..')

// The pictures the built-in themes ship are drawn by apps/server/scripts/theme-art.ts: the files are exactly what the
// script draws, and text stays readable on them (a theme's own colours are only judged against flat colours elsewhere;
// over a picture the ground is the picture, dimmed).
test.each(Object.entries(themeArt))('%s is exactly what the script draws', (path, draw) => {
  expect(readFileSync(join(ROOT, path)).equals(draw())).toBe(true)
})

type Rgb = [number, number, number]
const hex = (value: string): Rgb => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
]
const channel = (v: number) => {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
const over = (top: Rgb, alpha: number, bottom: Rgb): Rgb => [
  top[0] * alpha + bottom[0] * (1 - alpha),
  top[1] * alpha + bottom[1] * (1 - alpha),
  top[2] * alpha + bottom[2] * (1 - alpha),
]

/** The darkest and the lightest backdrop of the picture once the theme's veil (the ground colour, `dim` %) is on it. */
function extremes(pixels: Uint8Array, ground: Rgb, dim: number): { dark: Rgb; light: Rgb } {
  let dark: Rgb = [255, 255, 255]
  let light: Rgb = [0, 0, 0]
  for (let i = 0; i < pixels.length; i += 3) {
    const veiled = over(ground, dim / 100, [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!])
    if (luminance(veiled) < luminance(dark)) dark = veiled
    if (luminance(veiled) > luminance(light)) light = veiled
  }
  return { dark, light }
}

/** Custom properties declared in the rule that starts with `selector` (the same reader the web contrast tests use). */
function declared(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`)
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]),
  )
}
const tokens = readFileSync(join(ROOT, 'apps/web/src/styles/tokens.css'), 'utf8')
// What a theme leaves out is Score's own: the agent colours are never a theme's to set, so every theme inherits them.
const scoreColors = {
  light: declared(tokens, ":root,\n[data-pack='score']"),
  dark: {
    ...declared(tokens, ":root,\n[data-pack='score']"),
    ...declared(tokens, ":root[data-theme='dark'],\n[data-pack='score'][data-theme='dark']"),
  },
}
const agents = ['violet', 'jade', 'saffron', 'coral'].map((name) => `agent-${name}-text`)
// Text drawn straight on the page (headings, hints, room lists, agent status lines) and inside cards.
const texts = ['ink', 'ink-muted', 'muted', 'chat-text', 'chat-secondary', ...agents]

describe.each([
  ['harbour', 'apps/server/themes/harbour', renderHarbour, HARBOUR],
  ['ledger', 'apps/server/themes/ledger', null, null],
  ['studio', 'apps/server/themes/studio', null, null],
  ['sandbar (the example theme)', 'docs/themes/example-theme', renderSand, SAND],
] as const)('%s', (_name, folder, render, size) => {
  const manifest = ThemeManifestSchema.parse(
    JSON.parse(readFileSync(join(ROOT, folder, 'theme.json'), 'utf8')),
  )
  const pixels = render ? render() : null
  if (pixels && size) expect(pixels.length).toBe(size.width * size.height * 3)
  expect(Boolean(manifest.background)).toBe(Boolean(pixels))
  const dim = manifest.background?.dim ?? 0
  const glass = manifest.shape?.surface === 'glass'

  describe.each(['light', 'dark'] as const)('%s', (mode) => {
    const colors = { ...scoreColors[mode], ...manifest.colors![mode]! } as Record<string, string>
    const ground = hex(colors.ground!)
    const card = hex(colors.card!)
    // The page behind the text at its worst spots: the picture under its veil, or the flat ground.
    const open = pixels ? extremes(pixels, ground, dim) : { dark: ground, light: ground }
    const spots = [open.dark, open.light]

    test.each(texts)('%s is readable on the open page (AA, worst spot)', (token) => {
      for (const spot of spots) expect(ratio(hex(colors[token]!), spot)).toBeGreaterThanOrEqual(4.5)
    })

    // A card is solid, or with glass the card colour at 70 % over what is behind it (the blur only averages, so the
    // extremes bound it).
    test.each(texts)('%s is readable on a card (AA, worst spot)', (token) => {
      const behind = glass ? spots.map((spot) => over(card, 0.7, spot)) : [card]
      for (const spot of behind)
        expect(ratio(hex(colors[token]!), spot)).toBeGreaterThanOrEqual(4.5)
    })
  })
})
