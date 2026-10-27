import { expect, test } from 'vitest'
import { menuBox } from './menu-placement.ts'

// 3.8.1 (owner, phone): a menu stays inside the screen whichever side its button is on.

test('a button on the right keeps the menu right-aligned under it', () => {
  expect(menuBox({ left: 1340, right: 1380 }, 1440)).toEqual({ left: -260, width: 300 })
})

test('a button near the left edge of a phone shifts the menu right, inside the gutter', () => {
  // The owner's case: ⋯ at 140–180 on a 390 px screen; right-aligned it would start at -120.
  const box = menuBox({ left: 140, right: 180 }, 390)
  expect(140 + box.left).toBe(14)
  expect(box.width).toBe(300)
})

test('on a very narrow screen the menu takes the width between the gutters', () => {
  const box = menuBox({ left: 200, right: 240 }, 300)
  expect(box.width).toBe(272)
  expect(200 + box.left).toBe(14)
  expect(200 + box.left + box.width).toBe(286)
})
