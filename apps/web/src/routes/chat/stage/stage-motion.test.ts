import { expect, test } from 'vitest'
import {
  BREAK_FILES,
  gapBetween,
  initialPositions,
  pickBreak,
  pickTarget,
  restingMotion,
  stepToward,
  type Walker,
} from './stage-motion.ts'

const pet = (x: number, target = x): Walker => ({ id: `p${x}`, x, target, pet: true })
const mark = (x: number, target = x): Walker => ({ id: `m${x}`, x, target, pet: false })

test('members keep about 125 px around a pet and 85 px between marks', () => {
  expect(gapBetween(true, false)).toBe(125)
  expect(gapBetween(false, true)).toBe(125)
  expect(gapBetween(true, true)).toBe(125)
  expect(gapBetween(false, false)).toBe(85)
})

test('a spot is chosen where no one stands and no one is heading', () => {
  const self = pet(0.1)
  // 1000 px wide: a pet at 0.5 blocks 375..625; another heading to 0.8 blocks 675..925.
  const others = [pet(0.5), mark(0.2, 0.8)]
  for (let n = 0; n < 50; n += 1) {
    const target = pickTarget(self, others, 1000, Math.random)
    if (target === null) continue
    expect(Math.abs(target - 0.5) * 1000).toBeGreaterThan(125)
    expect(Math.abs(target - 0.8) * 1000).toBeGreaterThan(125)
    expect(Math.abs(target - 0.2) * 1000).toBeGreaterThan(125)
    expect(target).toBeGreaterThanOrEqual(0.08)
    expect(target).toBeLessThanOrEqual(0.92)
    expect(Math.abs(target - self.x) * 1000).toBeGreaterThan(60)
  }
})

test('no spot is chosen when the strip is full', () => {
  const crowd = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((x) => pet(x))
  expect(pickTarget(crowd[0]!, crowd.slice(1), 600, () => 0.5)).toBeNull()
})

test('walking steps toward the target at a steady pace and stops on it', () => {
  const first = stepToward(0.1, 0.9, 0.1, 700)
  expect(first.x).toBeCloseTo(0.1 + (70 / 700) * 0.1, 6)
  expect(first.arrived).toBe(false)
  expect(stepToward(0.5, 0.2, 0.1, 700).x).toBeLessThan(0.5)
  expect(stepToward(0.2, 0.2005, 0.1, 700)).toEqual({ x: 0.2005, arrived: true })
})

test('members start spread across the strip', () => {
  const xs = initialPositions(4)
  expect(xs).toHaveLength(4)
  expect(xs.every((x, i) => x > 0 && x < 1 && (i === 0 || x > xs[i - 1]!))).toBe(true)
  expect(initialPositions(0)).toEqual([])
})

test('breaks use only files the pack has', () => {
  expect(BREAK_FILES).toEqual(['coffee', 'stretch', 'read'])
  expect(pickBreak(new Set(['idle', 'walk']), () => 0)).toBeNull()
  expect(pickBreak(new Set(['idle', 'read', 'coffee']), () => 0)).toBe('coffee')
  expect(pickBreak(new Set(['idle', 'read', 'coffee']), () => 0.99)).toBe('read')
})

test('what a resting member may do depends on the liveliness', () => {
  expect(restingMotion('lively', 'rest', true)).toEqual({ walks: true, breaks: true })
  // Marks hop while moving but take no breaks.
  expect(restingMotion('lively', 'rest', false)).toEqual({ walks: true, breaks: false })
  // Calm and Still never wander, and a member with a mood stays where it is.
  expect(restingMotion('calm', 'rest', true)).toEqual({ walks: false, breaks: false })
  expect(restingMotion('still', 'rest', true)).toEqual({ walks: false, breaks: false })
  expect(restingMotion('lively', 'work', true)).toEqual({ walks: false, breaks: false })
  expect(restingMotion('lively', 'sleep', true)).toEqual({ walks: false, breaks: false })
})
