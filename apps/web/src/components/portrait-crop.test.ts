import { expect, test } from 'vitest'
import { portraitCrop } from './portrait-crop.ts'

function frame(width: number, height: number, firstOpaqueRow: number | null) {
  const data = new Uint8ClampedArray(width * height * 4)
  if (firstOpaqueRow !== null)
    for (let y = firstOpaqueRow; y < height; y += 1)
      for (let x = 10; x < width - 10; x += 1) data[(y * width + x) * 4 + 3] = 255
  return data
}

test('the square starts at the top of the character, centred, 45% of the height', () => {
  const crop = portraitCrop(frame(100, 200, 30), 100, 200)
  expect(crop).toEqual({ x: (100 - 90) / 2, y: 30, side: 90 })
})

test('faint pixels (alpha 16 or less) are not the character', () => {
  const data = frame(100, 200, 50)
  data[(20 * 100 + 50) * 4 + 3] = 10
  expect(portraitCrop(data, 100, 200).y).toBe(50)
})

test('a blank frame falls back to the top 45%', () => {
  expect(portraitCrop(frame(100, 200, null), 100, 200)).toEqual({ x: 5, y: 0, side: 90 })
})

test('the square never leaves the frame', () => {
  expect(portraitCrop(frame(100, 200, 190), 100, 200).y).toBe(110)
})
