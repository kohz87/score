import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { contrastRatio, type Rgba } from '../themes/color.ts'

// Third gate, finding 3: a bare glyph sits on a plate that is always at least 3:1 against the agent's colour
// (WCAG 1.4.11), whatever colour the agent has. The plate is computed in CSS (relative colour); this walks the colour
// cube with the same constants, read from the stylesheet so the two cannot drift apart.
const css = readFileSync('src/components/agent-glyph.css', 'utf8')
const lum = (/--glyph-lum: \(([^;]*)\);/.exec(css)?.[1] ?? '').replace(/\s+/g, ' ').trim()
const dark = /--glyph-dark: clamp\(0, \((\d\.\d+) - var\(--glyph-lum\)\) \* (\d+), 1\);/.exec(css)
const threshold = Number(dark?.[1])
const plate = /--glyph-plate: rgb\(([\s\S]*?)\n {2}\);/.exec(css)?.[1] ?? ''

test('the plate formula is in the stylesheet', () => {
  expect(plate).toContain('from var(--glyph-color)')
  expect(plate).toContain('calc(18 + 237 * var(--glyph-dark))')
  expect(plate).toContain('calc(19 + 236 * var(--glyph-dark))')
  expect(plate).toContain('calc(26 + 229 * var(--glyph-dark))')
  expect(lum).toBe(
    '0.2126 * pow(r / 255, 2.2) + 0.7152 * pow(g / 255, 2.2) + 0.0722 * pow(b / 255, 2.2)',
  )
  expect(threshold).toBe(0.1935)
})

function plateOf(r: number, g: number, b: number): Rgba {
  const y = 0.2126 * (r / 255) ** 2.2 + 0.7152 * (g / 255) ** 2.2 + 0.0722 * (b / 255) ** 2.2
  return threshold - y > 0 ? [1, 1, 1, 1] : [18 / 255, 19 / 255, 26 / 255, 1]
}

test('every colour keeps at least 3:1 against its plate', () => {
  let worst = Infinity
  let at = ''
  for (let r = 0; r <= 255; r += 5)
    for (let g = 0; g <= 255; g += 5)
      for (let b = 0; b <= 255; b += 5) {
        const ratio = contrastRatio([r / 255, g / 255, b / 255, 1], plateOf(r, g, b))
        if (ratio < worst) {
          worst = ratio
          at = `${r},${g},${b}`
        }
      }
  expect(worst, `worst at ${at}`).toBeGreaterThanOrEqual(3)
})

test('the palette colours and the extremes read on their plates', () => {
  for (const hex of [
    '#6B4EFF',
    '#19C39A',
    '#FFB61E',
    '#FF6B8A',
    '#FFFFFF',
    '#000000',
    '#12131A',
    '#FF0000',
  ]) {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [
      number,
      number,
      number,
    ]
    expect(
      contrastRatio([r / 255, g / 255, b / 255, 1], plateOf(r, g, b)),
      hex,
    ).toBeGreaterThanOrEqual(3)
  }
})

test('Score’s own coral reads against the ink edge a Needs-you dot wears', () => {
  expect(
    contrastRatio([1, 107 / 255, 138 / 255, 1], [18 / 255, 19 / 255, 26 / 255, 1]),
  ).toBeGreaterThanOrEqual(3)
})
