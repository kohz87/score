import type { PetActivity } from '@score/contract'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Liveliness } from '../data/liveliness.ts'
import {
  EXTRA_EVERY_MS,
  GREET_MS,
  HAPPY_MS,
  SLEEP_AFTER_MS,
  createPetScheduler,
  extraMs,
  type PetMood,
} from './pet-scheduler.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const pack = (...names: PetActivity[]) => new Set<PetActivity>(['idle', ...names])
function make(
  options: {
    mood?: PetMood
    liveliness?: Liveliness
    activities?: Set<PetActivity>
    random?: () => number
  } = {},
) {
  const pet = createPetScheduler({
    mood: options.mood ?? 'idle',
    liveliness: options.liveliness ?? 'lively',
    activities: options.activities ?? pack(),
    random: options.random ?? (() => 0),
  })
  pet.start()
  return pet
}
const step = (ms: number) => vi.advanceTimersByTime(ms)

test('each mood plays its own file when the pack has it', () => {
  const all = pack('work', 'think', 'needs')
  const pet = make({ activities: all })
  expect(pet.getSnapshot()).toMatchObject({ file: 'idle', overlay: null, hop: false })
  pet.setMood('working')
  expect(pet.getSnapshot()).toMatchObject({ file: 'work', overlay: null })
  pet.setMood('thinking')
  expect(pet.getSnapshot()).toMatchObject({ file: 'think', overlay: null })
  pet.setMood('needs')
  expect(pet.getSnapshot()).toMatchObject({ file: 'needs', overlay: null, hop: false })
})

test('a mood the pack has no file for falls back to idle with Score’s overlay', () => {
  const pet = make({ mood: 'thinking' })
  expect(pet.getSnapshot()).toMatchObject({ file: 'idle', overlay: 'dots', hop: false })
  pet.setMood('needs')
  expect(pet.getSnapshot()).toMatchObject({ file: 'idle', overlay: 'alert', hop: true })
  pet.setMood('working')
  // Working has no overlay: with no `work` file the pet just rests.
  expect(pet.getSnapshot()).toMatchObject({ file: 'idle', overlay: null, hop: false })
})

test('a pack with only idle works for every mood and never names a file it lacks', () => {
  const pet = make({ activities: pack() })
  for (const mood of ['idle', 'working', 'thinking', 'needs'] as const) {
    pet.setMood(mood)
    expect(pet.getSnapshot().file).toBe('idle')
  }
})

test('the pack can change under the pet (a new revision)', () => {
  const pet = make({ mood: 'working' })
  expect(pet.getSnapshot().file).toBe('idle')
  pet.setActivities(pack('work'))
  expect(pet.getSnapshot().file).toBe('work')
  pet.setActivities(pack())
  expect(pet.getSnapshot().file).toBe('idle')
})

test('after about 25 seconds without attention a resting pet sleeps: the file, or z’s over idle', () => {
  const withSleep = make({ activities: pack('sleep') })
  const without = make()
  step(SLEEP_AFTER_MS - 1)
  expect(withSleep.getSnapshot().file).toBe('idle')
  step(1)
  expect(withSleep.getSnapshot().file).toBe('sleep')
  expect(without.getSnapshot()).toMatchObject({ file: 'idle', overlay: 'zzz' })
})

test('attention wakes it and starts the wait again: a greeting, a click, a new mood', () => {
  const pet = make({ activities: pack('sleep') })
  step(SLEEP_AFTER_MS)
  expect(pet.getSnapshot().file).toBe('sleep')
  pet.pointerEnter()
  expect(pet.getSnapshot().file).toBe('idle')
  step(SLEEP_AFTER_MS - 1)
  expect(pet.getSnapshot().file).toBe('idle')
  step(1)
  expect(pet.getSnapshot().file).toBe('sleep')
  pet.setMood('working')
  expect(pet.getSnapshot().file).toBe('idle')
  pet.setMood('idle')
  step(SLEEP_AFTER_MS - 1)
  expect(pet.getSnapshot().file).toBe('idle')
})

test('only a resting pet sleeps', () => {
  const pet = make({ mood: 'working', activities: pack('work', 'sleep') })
  step(SLEEP_AFTER_MS * 3)
  expect(pet.getSnapshot().file).toBe('work')
})

test('Lively resting pets take the breaks the pack has, one at a time, then rest again', () => {
  const pet = make({ activities: pack('walk', 'coffee') })
  step(EXTRA_EVERY_MS[0])
  // random() = 0 picks the first break the pack has, in the order walk, stretch, coffee, read.
  expect(pet.getSnapshot().file).toBe('walk')
  step(extraMs.walk)
  expect(pet.getSnapshot().file).toBe('idle')
  step(EXTRA_EVERY_MS[0])
  expect(pet.getSnapshot().file).toBe('walk')
})

test('a break is chosen among the optional files only', () => {
  const pick = (random: number) => {
    const pet = make({
      activities: pack('walk', 'stretch', 'coffee', 'read', 'work'),
      random: () => random,
    })
    // The break starts somewhere in the window; look just after it began.
    step(EXTRA_EVERY_MS[0] + random * (EXTRA_EVERY_MS[1] - EXTRA_EVERY_MS[0]) + 1)
    return pet.getSnapshot().file
  }
  expect(pick(0)).toBe('walk')
  expect(pick(0.3)).toBe('stretch')
  expect(pick(0.6)).toBe('coffee')
  expect(pick(0.9)).toBe('read')
})

test('sleep is counted from the last attention, not from the end of a break', () => {
  const pet = make({ activities: pack('walk', 'sleep') })
  step(EXTRA_EVERY_MS[0])
  expect(pet.getSnapshot().file).toBe('walk')
  step(SLEEP_AFTER_MS - EXTRA_EVERY_MS[0])
  expect(pet.getSnapshot().file).toBe('sleep')
})

test('a working pet may stretch, drink coffee or read but never strolls; thinking and needs take no breaks', () => {
  const working = make({ mood: 'working', activities: pack('work', 'walk', 'stretch') })
  step(EXTRA_EVERY_MS[0] + 1)
  expect(working.getSnapshot().file).toBe('stretch')
  const thinking = make({ mood: 'thinking', activities: pack('think', 'stretch') })
  step(EXTRA_EVERY_MS[1] * 3)
  expect(thinking.getSnapshot().file).toBe('think')
  const needs = make({ mood: 'needs', activities: pack('needs', 'stretch') })
  step(EXTRA_EVERY_MS[1] * 3)
  expect(needs.getSnapshot().file).toBe('needs')
})

test('a break ends when the mood changes', () => {
  const pet = make({ activities: pack('walk', 'work') })
  step(EXTRA_EVERY_MS[0])
  expect(pet.getSnapshot().file).toBe('walk')
  pet.setMood('working')
  expect(pet.getSnapshot().file).toBe('work')
})

test('Calm has no breaks and no sleep, only the mood', () => {
  const pet = make({ liveliness: 'calm', activities: pack('walk', 'sleep', 'stretch') })
  step(SLEEP_AFTER_MS * 4)
  expect(pet.getSnapshot()).toMatchObject({ file: 'idle', overlay: null })
})

test('Still moves nothing: no breaks, no sleep, no greeting, no heart', () => {
  const pet = make({ liveliness: 'still', activities: pack('walk', 'sleep', 'greet', 'happy') })
  step(SLEEP_AFTER_MS * 4)
  pet.pointerEnter()
  pet.click()
  expect(pet.getSnapshot()).toMatchObject({ file: 'idle', saying: false, love: false, hearts: 0 })
})

test('choosing Calm or Still takes a pet out of a break or sleep at once, and Lively starts the waiting again', () => {
  const pet = make({ activities: pack('walk', 'sleep') })
  step(EXTRA_EVERY_MS[0])
  expect(pet.getSnapshot().file).toBe('walk')
  pet.setLiveliness('calm')
  expect(pet.getSnapshot().file).toBe('idle')
  step(SLEEP_AFTER_MS * 2)
  expect(pet.getSnapshot().file).toBe('idle')
  pet.setLiveliness('lively')
  step(SLEEP_AFTER_MS)
  expect(pet.getSnapshot().file).toBe('sleep')
})

test('pointing at it plays greet, or says hi when the pack has none, for a moment', () => {
  const withGreet = make({ activities: pack('greet') })
  const without = make()
  withGreet.pointerEnter()
  without.pointerEnter()
  expect(withGreet.getSnapshot()).toMatchObject({ file: 'greet', saying: false })
  expect(without.getSnapshot()).toMatchObject({ file: 'idle', saying: true })
  step(GREET_MS)
  expect(withGreet.getSnapshot().file).toBe('idle')
  expect(without.getSnapshot().saying).toBe(false)
})

test('clicking plays happy, or raises a heart and a bounce when the pack has none; each click is a new heart', () => {
  const withHappy = make({ activities: pack('happy') })
  const without = make()
  withHappy.click()
  without.click()
  expect(withHappy.getSnapshot()).toMatchObject({ file: 'happy', love: false })
  expect(without.getSnapshot()).toMatchObject({ file: 'idle', love: true, hearts: 1 })
  without.click()
  expect(without.getSnapshot().hearts).toBe(2)
  step(HAPPY_MS)
  expect(withHappy.getSnapshot().file).toBe('idle')
  expect(without.getSnapshot().love).toBe(false)
})

test('Calm still greets and bounces, and the mood file still plays', () => {
  const pet = make({
    liveliness: 'calm',
    mood: 'working',
    activities: pack('work', 'greet', 'happy'),
  })
  pet.pointerEnter()
  expect(pet.getSnapshot().file).toBe('greet')
  step(GREET_MS)
  expect(pet.getSnapshot().file).toBe('work')
  pet.click()
  expect(pet.getSnapshot().file).toBe('happy')
})

test('a hidden tab pauses the timers, and showing it again starts the waiting afresh', () => {
  const pet = make({ activities: pack('sleep') })
  step(SLEEP_AFTER_MS - 1000)
  pet.setHidden(true)
  step(SLEEP_AFTER_MS * 3)
  expect(pet.getSnapshot().file).toBe('idle')
  pet.setHidden(false)
  step(SLEEP_AFTER_MS - 1)
  expect(pet.getSnapshot().file).toBe('idle')
  step(1)
  expect(pet.getSnapshot().file).toBe('sleep')
})

test('listeners hear only real changes, and a destroyed pet stays quiet', () => {
  const pet = make({ activities: pack('walk') })
  const heard = vi.fn()
  const stop = pet.subscribe(heard)
  pet.setMood('idle')
  pet.setLiveliness('lively')
  expect(heard).not.toHaveBeenCalled()
  step(EXTRA_EVERY_MS[0])
  expect(heard).toHaveBeenCalledTimes(1)
  stop()
  pet.destroy()
  step(SLEEP_AFTER_MS * 2)
  expect(heard).toHaveBeenCalledTimes(1)
})

test('nothing runs until it is started, and it can be stopped and started again (StrictMode mounts twice)', () => {
  const pet = createPetScheduler({
    mood: 'idle',
    liveliness: 'lively',
    activities: pack('sleep'),
    random: () => 0,
  })
  step(SLEEP_AFTER_MS * 2)
  expect(pet.getSnapshot().file).toBe('idle')
  pet.start()
  pet.destroy()
  step(SLEEP_AFTER_MS * 2)
  expect(pet.getSnapshot().file).toBe('idle')
  pet.start()
  step(SLEEP_AFTER_MS)
  expect(pet.getSnapshot().file).toBe('sleep')
})
