import { expect, test } from 'vitest'
import { CHIP_MIN_HEIGHT, chipClearance, jumpTarget } from './needs-jump.ts'

const view = { top: 100, bottom: 500 }

// Replaces pins-overflow.test.ts (the pinned box's "N more below" arithmetic): the chip counts cards out of view.
test('no chip while every card is in view (its bottom above the view’s bottom; a card cut off at the top still shows)', () => {
  expect(
    jumpTarget(view, [
      { key: 'a', top: 120, bottom: 220 },
      { key: 'b', top: 450, bottom: 500 },
      { key: 'c', top: 20, bottom: 140 },
    ]),
  ).toBeNull()
})

test('a card entirely below the view points down and is the target', () => {
  expect(jumpTarget(view, [{ key: 'a', top: 520, bottom: 640 }])).toEqual({
    count: 1,
    direction: 'down',
    key: 'a',
  })
})

test('a card entirely above the view points up', () => {
  expect(jumpTarget(view, [{ key: 'a', top: -200, bottom: 40 }])).toEqual({
    count: 1,
    direction: 'up',
    key: 'a',
  })
})

test('with cards on both sides the count is all of them and the target is the nearest', () => {
  expect(
    jumpTarget(view, [
      { key: 'far-up', top: -900, bottom: -700 },
      { key: 'near-down', top: 540, bottom: 700 },
      { key: 'in-view', top: 200, bottom: 300 },
    ]),
  ).toEqual({ count: 2, direction: 'down', key: 'near-down' })
})

test('the chip clears its own height, its lift and a gap; a chip never counts shorter than its CSS height', () => {
  expect(chipClearance(36)).toBe(52)
  expect(chipClearance(40)).toBe(56)
  expect(chipClearance(0)).toBe(CHIP_MIN_HEIGHT + 16)
})

test('a card whose bottom is under the chip counts as below, so the chip never covers its buttons', () => {
  const clearance = chipClearance(36)
  // Inside the view, but its bottom edge is within the chip's strip (500 - 52 = 448).
  expect(jumpTarget(view, [{ key: 'a', top: 300, bottom: 460 }], clearance)).toEqual({
    count: 1,
    direction: 'down',
    key: 'a',
  })
  // Its bottom is just above the strip: in view.
  expect(jumpTarget(view, [{ key: 'a', top: 300, bottom: 448 }], clearance)).toBeNull()
  // Without a chip the same card is in view.
  expect(jumpTarget(view, [{ key: 'a', top: 300, bottom: 460 }])).toBeNull()
})

test('the nearest card is measured from the top of the chip’s strip', () => {
  const clearance = 52
  const result = jumpTarget(
    view,
    [
      { key: 'far', top: 900, bottom: 1000 },
      { key: 'near', top: 440, bottom: 480 },
    ],
    clearance,
  )
  expect(result).toEqual({ count: 2, direction: 'down', key: 'near' })
})
