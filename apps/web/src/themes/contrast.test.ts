import { describe, expect, test } from 'vitest'
import type { Rgba } from './color.ts'
import { backgroundLayers, worstContrast } from './contrast.ts'

const white: Rgba = [1, 1, 1, 1]
const black: Rgba = [0, 0, 0, 1]

describe('backgroundLayers', () => {
  test('a plain colour is one layer, a clear one none', () => {
    expect(backgroundLayers('none', 'rgb(255, 255, 255)')).toEqual([[[1, 1, 1, 1]]])
    expect(backgroundLayers('none', 'rgba(0, 0, 0, 0)')).toEqual([])
  })

  test('reads color() computed forms, which the old parser skipped', () => {
    expect(backgroundLayers('none', 'color(srgb 1 1 1)')).toEqual([[[1, 1, 1, 1]]])
  })

  test('a gradient contributes every stop, a picture black and white', () => {
    const layers = backgroundLayers(
      'linear-gradient(rgb(255, 0, 0), color(srgb 0 0 1 / 0.5)), url("http://x.test/a.png")',
      'rgb(1, 2, 3)',
    )!
    expect(layers).toHaveLength(3)
    expect(layers[0]).toHaveLength(2)
    expect(layers[1]).toEqual([black, white])
  })

  test('the page’s own picture can be left out, so the colour under it counts', () => {
    const layers = backgroundLayers(
      'linear-gradient(color(srgb 0.95 0.96 0.97 / 0.8), color(srgb 0.95 0.96 0.97 / 0.8)), url("http://x.test/a.png")',
      'rgb(241, 246, 249)',
      'ignore',
    )!
    expect(layers).toHaveLength(2)
    expect(worstContrast([0.07, 0.07, 0.1, 1], layers)!).toBeGreaterThan(10)
  })

  test('an image function it does not know is unmeasurable', () => {
    expect(backgroundLayers('image-set(url(a.png) 1x)', 'rgb(0, 0, 0)')).toBeNull()
    expect(backgroundLayers('none', 'not-a-colour')).toBeNull()
  })
})

describe('worstContrast', () => {
  test('white on white fails, dark on white passes', () => {
    expect(worstContrast(white, [[white]])).toBeCloseTo(1, 5)
    expect(worstContrast(black, [[white]])).toBeCloseTo(21, 5)
  })

  test('the first opaque layer hides what is under it', () => {
    // The stack is listed top first.
    expect(worstContrast(black, [[white], [black]])).toBeCloseTo(21, 5)
    expect(worstContrast(black, [[black], [white]])).toBeCloseTo(1, 5)
    expect(worstContrast(white, [[black], [white]])).toBeCloseTo(21, 5)
  })

  test('over a picture, text must beat both black and white behind it', () => {
    const picture = backgroundLayers('url("http://x.test/a.png")', 'rgba(0, 0, 0, 0)')!
    expect(worstContrast(black, picture)).toBeLessThan(2)
    expect(worstContrast([0.5, 0.5, 0.5, 1], picture)).toBeLessThan(5)
  })

  test('a veil over a picture is measured through the veil', () => {
    const layers = backgroundLayers(
      'linear-gradient(color(srgb 0.95 0.96 0.97 / 0.8), color(srgb 0.95 0.96 0.97 / 0.8)), url("http://x.test/a.png")',
      'rgba(0, 0, 0, 0)',
    )!
    expect(worstContrast([0.07, 0.07, 0.1, 1], layers)!).toBeGreaterThan(4.5)
  })

  test('a gradient the text colour sits inside vanishes', () => {
    const layers = backgroundLayers(
      'linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))',
      'rgba(0, 0, 0, 0)',
    )!
    expect(worstContrast([0.5, 0.5, 0.5, 1], layers)).toBe(1)
  })
})
