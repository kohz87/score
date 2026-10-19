import { expect, test } from 'vitest'
import {
  BREAK_FILES,
  gapBetween,
  initialPositions,
  petView,
  placeNewcomer,
  pickBreak,
  pickTarget,
  restingMotion,
  shownMembers,
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

test('a pet plays the file for its mood and falls back to idle with Score’s own overlay', () => {
  const rich = new Set(['idle', 'work', 'think', 'needs', 'sleep', 'walk', 'coffee'])
  const bare = new Set(['idle'])
  const still = { mode: 'idle' as const }
  expect(petView('rest', still, rich)).toEqual({ file: 'idle', overlay: null })
  expect(petView('work', still, rich)).toEqual({ file: 'work', overlay: null })
  expect(petView('think', still, rich)).toEqual({ file: 'think', overlay: null })
  expect(petView('think', still, bare)).toEqual({ file: 'idle', overlay: 'dots' })
  expect(petView('sleep', still, rich)).toEqual({ file: 'sleep', overlay: null })
  expect(petView('sleep', still, bare)).toEqual({ file: 'idle', overlay: 'zzz' })
  // "Waiting for you" always shows the "!", with its file or without.
  expect(petView('needs', still, rich)).toEqual({ file: 'needs', overlay: 'bang' })
  expect(petView('needs', still, bare)).toEqual({ file: 'idle', overlay: 'bang' })
  expect(petView('work', still, bare)).toEqual({ file: 'idle', overlay: null })
  // Resting: walking and breaks only with their files.
  expect(petView('rest', { mode: 'walk' }, rich).file).toBe('walk')
  expect(petView('rest', { mode: 'walk' }, bare).file).toBe('idle')
  expect(petView('rest', { mode: 'break', file: 'coffee' }, rich).file).toBe('coffee')
  expect(petView('rest', { mode: 'break', file: 'read' }, rich).file).toBe('idle')
})

test('a short strip shows the first members, but never hides one that is waiting for you', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id, mood: 'rest' as const }))
  expect(shownMembers(ids, 5).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  expect(shownMembers(ids, 10)).toHaveLength(7)
  const waiting = ids.map((item) => (item.id === 'g' ? { ...item, mood: 'needs' as const } : item))
  expect(shownMembers(waiting, 5).map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'g'])
})

test('a newcomer is placed away from everyone standing or heading somewhere', () => {
  const others = [pet(0.5), mark(0.2, 0.8)]
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
  expect(placeNewcomer(0.9, [pet(0.2)])).toBe(0.9)
})
