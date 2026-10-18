import { describe, expect, it } from 'vitest'
import { contrastRatio, parseColor, parseComputedColor, type Rgba } from './color.ts'
import { worstRatio } from './customizer/checks.ts'

const near = (got: Rgba | null, want: number[]) => {
  expect(got).not.toBeNull()
  want.forEach((v, i) => expect(got![i]!).toBeCloseTo(v, 1))
}

describe('parseComputedColor', () => {
  it('reads what getComputedStyle gives for a color-mix', () => {
    expect(parseColor('color(srgb 1 1 1 / 0.7)')).toBeNull()
    near(parseComputedColor('color(srgb 1 1 1 / 0.7)'), [1, 1, 1, 0.7])
    near(parseComputedColor('color(srgb 0.5 0.25 0 / 0.2)'), [0.5, 0.25, 0, 0.2])
    near(parseComputedColor('color(srgb 100% 0% 0%)'), [1, 0, 0, 1])
  })
  it('keeps everything parseColor reads', () => {
    expect(parseComputedColor('#b0b0b0')).toEqual(parseColor('#b0b0b0'))
    expect(parseComputedColor('rgba(0, 0, 0, 0.5)')).toEqual(parseColor('rgba(0, 0, 0, 0.5)'))
  })
  it('reads the other spaces a browser may report', () => {
    near(parseComputedColor('oklab(1 0 0)'), [1, 1, 1, 1])
    near(parseComputedColor('lab(100 0 0)'), [1, 1, 1, 1])
    near(parseComputedColor('lab(0 0 0 / 0.5)'), [0, 0, 0, 0.5])
    near(parseComputedColor('lch(100 0 0)'), [1, 1, 1, 1])
    near(parseComputedColor('color(srgb-linear 1 1 1)'), [1, 1, 1, 1])
    near(parseComputedColor('color(display-p3 1 1 1)'), [1, 1, 1, 1])
    near(parseComputedColor('hwb(0 0% 0%)'), [1, 0, 0, 1])
    expect(parseComputedColor('color(unknown 1 1 1)')).toBeNull()
    expect(parseComputedColor('banana')).toBeNull()
  })
  it('a 70% white glass over black with #b0b0b0 text is too faint to read', () => {
    const glass = parseComputedColor('color(srgb 1 1 1 / 0.7)')!
    const text = parseComputedColor('rgb(176, 176, 176)')!
    const ratio = worstRatio(text, [glass], [[0, 0, 0, 1]])
    expect(ratio).toBeLessThan(1.2)
    expect(ratio).toBeLessThan(4.5)
    expect(contrastRatio(text, [0, 0, 0, 1])).toBeGreaterThan(4.5)
  })
})
