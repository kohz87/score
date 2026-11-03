import { expect, test } from 'vitest'
import { jumpTarget } from './needs-jump.ts'

const view = { top: 100, bottom: 500 }

// Replaces pins-overflow.test.ts (the pinned box's "N more below" arithmetic): the chip counts cards out of view.
test('no chip while every card is at least partly in view', () => {
  expect(
    jumpTarget(view, [
      { key: 'a', top: 120, bottom: 220 },
      { key: 'b', top: 450, bottom: 650 },
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
