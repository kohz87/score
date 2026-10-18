import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ThemeManifestSchema } from '@score/contract'
import { BUILTIN_THEMES_DIR } from '../../src/themes/builtin.ts'
import { HARBOUR, renderHarbour, themeArt } from '../../scripts/theme-art.ts'

// The pictures the built-in themes ship are drawn by apps/server/scripts/theme-art.ts: the files are exactly what the
// script draws, and text stays readable on them (a theme's own colours are only judged against flat colours elsewhere;
// over a picture the ground is the picture, dimmed).
test.each(Object.entries(themeArt))('%s is exactly what the script draws', (path, draw) => {
  expect(readFileSync(join(BUILTIN_THEMES_DIR, path)).equals(draw())).toBe(true)
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

describe('harbour', () => {
  const manifest = ThemeManifestSchema.parse(
    JSON.parse(readFileSync(join(BUILTIN_THEMES_DIR, 'harbour/theme.json'), 'utf8')),
  )
  const pixels = renderHarbour()
  expect(pixels.length).toBe(HARBOUR.width * HARBOUR.height * 3)
  const dim = manifest.background?.dim ?? 0
  // Text tokens drawn straight on the page (headings, hints, room lists) and inside cards.
  const texts = ['ink', 'ink-muted', 'muted', 'chat-text', 'chat-secondary'] as const

  describe.each(['light', 'dark'] as const)('%s', (mode) => {
    const colors = manifest.colors![mode]!
    const ground = hex(colors.ground!)
    const { dark, light } = extremes(pixels, ground, dim)

    test.each(texts)('%s is readable on the open picture (AA, worst spot)', (token) => {
      const text = hex(colors[token]!)
      expect(ratio(text, dark)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(text, light)).toBeGreaterThanOrEqual(4.5)
    })

    test.each(texts)(
      '%s is readable on a glass card over the picture (AA, worst spot)',
      (token) => {
        // Glass: the card colour at 70 % over what is behind it (the blur only averages, so the extremes bound it).
        const card = hex(colors.card!)
        const text = hex(colors[token]!)
        expect(ratio(text, over(card, 0.7, dark))).toBeGreaterThanOrEqual(4.5)
        expect(ratio(text, over(card, 0.7, light))).toBeGreaterThanOrEqual(4.5)
      },
    )
  })
})
