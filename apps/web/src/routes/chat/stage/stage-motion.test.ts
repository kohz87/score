import { expect, test } from 'vitest'
import { initialPositions, placeNewcomer, shownMembers, type Walker } from './stage-motion.ts'

const mark = (x: number, target = x): Walker => ({ id: `m${x}`, x, target })

test('members start spread across the strip', () => {
  const xs = initialPositions(4)
  expect(xs).toHaveLength(4)
  expect(xs.every((x, i) => x > 0 && x < 1 && (i === 0 || x > xs[i - 1]!))).toBe(true)
  expect(initialPositions(0)).toEqual([])
})

test('a short strip shows the first members, but never hides one that is waiting for you', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id, mood: 'rest' as const }))
  expect(shownMembers(ids, 5).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  expect(shownMembers(ids, 10)).toHaveLength(7)
  const waiting = ids.map((item) => (item.id === 'g' ? { ...item, mood: 'needs' as const } : item))
  expect(shownMembers(waiting, 5).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'g'])
})

test('a newcomer is placed away from everyone standing or heading somewhere', () => {
  const others = [mark(0.5), mark(0.2, 0.8)]
  const spot = placeNewcomer(0.8, others)
  for (const other of others) {
    expect(Math.abs(spot - other.x)).toBeGreaterThan(0.05)
    expect(Math.abs(spot - other.target)).toBeGreaterThan(0.05)
  }
  expect(spot).toBeGreaterThanOrEqual(0.08)
  expect(spot).toBeLessThanOrEqual(0.92)
  // Nobody there yet: the spot asked for.
  expect(placeNewcomer(0.3, [])).toBe(0.3)
  // A free preferred spot is kept.
  expect(placeNewcomer(0.9, [mark(0.2)])).toBe(0.9)
})
