import { AvatarEyesSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { defaultEyes, fallbackLid, moveBox, resizeBox, sampleLid } from './eye-marks.ts'

test('the starting boxes and a lid colour satisfy the contract', () => {
  expect(AvatarEyesSchema.safeParse({ ...defaultEyes, lid: fallbackLid }).success).toBe(true)
})

test('a box moves inside the picture and never leaves it', () => {
  const box = { x: 0.5, y: 0.5, w: 0.2, h: 0.1 }
  expect(moveBox(box, 0.1, -0.1)).toEqual({ x: 0.6, y: 0.4, w: 0.2, h: 0.1 })
  expect(moveBox(box, 5, 5)).toEqual({ x: 0.8, y: 0.9, w: 0.2, h: 0.1 })
  expect(moveBox(box, -5, -5)).toEqual({ x: 0, y: 0, w: 0.2, h: 0.1 })
})

test('a box resizes from its far corner, to at least 2% and no further than the picture', () => {
  const box = { x: 0.5, y: 0.5, w: 0.2, h: 0.1 }
  expect(resizeBox(box, 0.1, 0.1)).toEqual({ x: 0.5, y: 0.5, w: 0.30000000000000004, h: 0.2 })
  expect(resizeBox(box, 5, 5)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })
  expect(resizeBox(box, -5, -5)).toEqual({ x: 0.5, y: 0.5, w: 0.02, h: 0.02 })
})

function picture(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4)
  return { width, height, data }
}

test('the lid colour is the average of the band just under each box', () => {
  // Skin (200, 150, 100) below row 40 of 100; the eye itself (dark) must not be counted.
  const image = picture(100, 100, (_, y) => (y < 40 ? [10, 10, 10, 255] : [200, 150, 100, 255]))
  const box = { x: 0.2, y: 0.3, w: 0.2, h: 0.1 }
  expect(sampleLid(image, [box, { ...box, x: 0.6 }])).toBe('#C89664')
})

test('a band is the mean of different colours under the two eyes', () => {
  const image = picture(100, 100, (x, y) =>
    y < 40 ? [0, 0, 0, 255] : x < 50 ? [200, 100, 0, 255] : [100, 100, 200, 255],
  )
  const left = { x: 0.2, y: 0.3, w: 0.2, h: 0.1 }
  expect(sampleLid(image, [left, { ...left, x: 0.6 }])).toBe('#966464')
})

test('transparent pixels are skipped, and a picture with nothing to sample gives the neutral colour', () => {
  const half = picture(10, 10, (x) => (x < 5 ? [0, 0, 0, 0] : [100, 50, 20, 255]))
  expect(sampleLid(half, [{ x: 0, y: 0, w: 1, h: 0.2 }])).toBe('#643214')
  const empty = picture(10, 10, () => [0, 0, 0, 0])
  expect(sampleLid(empty, [{ x: 0.1, y: 0.1, w: 0.3, h: 0.2 }])).toBe(fallbackLid)
})

test('a band that runs past the bottom edge is cut at the picture', () => {
  const image = picture(20, 20, () => [10, 20, 30, 255])
  expect(sampleLid(image, [{ x: 0.1, y: 0.8, w: 0.3, h: 0.1 }])).toBe('#0A141E')
  // A band that starts below the picture has nothing to sample.
  expect(sampleLid(image, [{ x: 0.1, y: 0.9, w: 0.3, h: 0.1 }])).toBe(fallbackLid)
})
