import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  SLEEP_AFTER_MS,
  actBase,
  createPetEngine,
  idleChoices,
  type PetAct,
  type PetEngine,
  type PetMood,
} from './pet-engine.ts'
import type { Liveliness } from '../data/liveliness.ts'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => {
  vi.useRealTimers()
})

/** A random source that walks through the given values, then repeats the last. */
function sequence(...values: number[]) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]!
}

/** The random value that makes the idle pick land on `act` (the middle of its slice of the weights). */
function forIdle(act: PetAct): number {
  const total = idleChoices.reduce((sum, [, weight]) => sum + weight, 0)
  let before = 0
  for (const [name, weight] of idleChoices) {
    if (name === act) return (before + weight / 2) / total
    before += weight
  }
  throw new Error(`${act} is not an idle choice`)
}

function pet(
  mood: PetMood = 'idle',
  liveliness: Liveliness = 'lively',
  random: () => number = () => 0.5,
): PetEngine {
  const engine = createPetEngine({ mood, liveliness, random, width: () => 200 })
  engine.start()
  return engine
}

const acts = (engine: PetEngine) => engine.getSnapshot().act

test('an idle pet picks from its whole repertoire, a different act each time its last one ends', () => {
  const picks: PetAct[] = ['walk', 'look', 'sit', 'stretch', 'yawn', 'hop']
  const engine = pet('idle', 'lively', sequence(...picks.flatMap((a) => [forIdle(a), 0.5])))
  const seen: PetAct[] = []
  for (let i = 0; i < picks.length; i++) {
    seen.push(acts(engine))
    vi.advanceTimersToNextTimer()
  }
  expect(seen).toEqual(picks)
  engine.destroy()
})

test('every idle act shows the resting mood; yawning squints and sleeping shuts the eyes', () => {
  expect(idleChoices.map(([name]) => actBase[name as Exclude<PetAct, 'rest'>])).toEqual(
    idleChoices.map(() => 'idle'),
  )
  const engine = pet('idle', 'lively', sequence(forIdle('yawn'), 0.5))
  expect(engine.getSnapshot().pose).toBe('yawn')
  engine.destroy()
})

test('walking moves to a place inside the corner, faces the way it goes, and takes longer when farther', () => {
  const far = pet('idle', 'lively', sequence(forIdle('walk'), 0.0))
  const farSnap = far.getSnapshot()
  expect(farSnap.act).toBe('walk')
  expect(farSnap.x).toBeGreaterThanOrEqual(0.15)
  expect(farSnap.x).toBeLessThanOrEqual(0.85)
  expect(farSnap.facing).toBe('left')
  far.destroy()
  const right = pet('idle', 'lively', sequence(forIdle('walk'), 1))
  expect(right.getSnapshot().x).toBeLessThanOrEqual(0.85)
  expect(right.getSnapshot().facing).toBe('right')
  right.destroy()
  const near = pet('idle', 'lively', sequence(forIdle('walk'), 0.4))
  expect(near.getSnapshot().walkMs).toBeGreaterThanOrEqual(300)
  expect(farSnap.walkMs).toBeGreaterThan(near.getSnapshot().walkMs)
  near.destroy()
})

test('a working pet walks to its desk, then types, with the odd stretch break', () => {
  // Wanders off to the left first, then gets a job.
  const engine = pet(
    'idle',
    'lively',
    sequence(forIdle('walk'), 0, 0.5, 0.5, 0.9, 0.5, 0.01, 0.5, 0.9, 0.5),
  )
  expect(engine.getSnapshot().x).toBeLessThan(0.3)
  engine.setMood('working')
  expect(engine.getSnapshot().act).toBe('walk')
  expect(engine.getSnapshot().x).toBe(0.5)
  expect(engine.getSnapshot().facing).toBe('right')
  vi.advanceTimersByTime(engine.getSnapshot().walkMs)
  expect(acts(engine)).toBe('type')
  expect(engine.getSnapshot().base).toBe('working')
  vi.advanceTimersToNextTimer()
  expect(acts(engine)).toBe('stretch')
  vi.advanceTimersToNextTimer()
  expect(acts(engine)).toBe('type')
  engine.destroy()
})

test('a thinking pet paces, then ponders, then paces again, with the thought dots mood', () => {
  const engine = pet('thinking', 'lively', sequence(0.5))
  expect(acts(engine)).toBe('pace')
  expect(engine.getSnapshot().base).toBe('thinking')
  vi.advanceTimersByTime(engine.getSnapshot().walkMs)
  expect(acts(engine)).toBe('ponder')
  vi.advanceTimersByTime(2500)
  expect(acts(engine)).toBe('pace')
  engine.destroy()
})

test('a pet that needs you cheers and stays cheering; it never falls asleep', () => {
  const engine = pet('needs')
  expect(acts(engine)).toBe('cheer')
  expect(engine.getSnapshot().base).toBe('needs')
  vi.advanceTimersByTime(10 * SLEEP_AFTER_MS)
  expect(acts(engine)).toBe('cheer')
  engine.destroy()
})

test('an idle pet falls asleep after about 25 seconds without attention, and a sleeper sets no timer', () => {
  const engine = pet('idle')
  vi.advanceTimersByTime(SLEEP_AFTER_MS + 10_000)
  expect(acts(engine)).toBe('sleep')
  expect(engine.getSnapshot().pose).toBe('sleep')
  expect(vi.getTimerCount()).toBe(0)
  engine.destroy()
})

test('working and thinking pets do not fall asleep', () => {
  for (const mood of ['working', 'thinking'] as const) {
    const engine = pet(mood)
    vi.advanceTimersByTime(5 * SLEEP_AFTER_MS)
    expect(acts(engine)).not.toBe('sleep')
    engine.destroy()
  }
})

test('a sleeper wakes and says hi when the pointer arrives', () => {
  const engine = pet('idle')
  vi.advanceTimersByTime(SLEEP_AFTER_MS + 10_000)
  engine.pointerEnter(0.4)
  const snap = engine.getSnapshot()
  expect(snap.act).toBe('greet')
  expect(snap.saying).toBe(true)
  expect(snap.pose).toBeUndefined()
  vi.advanceTimersByTime(1200)
  expect(engine.getSnapshot().saying).toBe(false)
  expect(acts(engine)).toBe('look')
  engine.destroy()
})

test('a click wakes a sleeper with a hop and a heart, and a second click makes another heart', () => {
  const engine = pet('idle')
  vi.advanceTimersByTime(SLEEP_AFTER_MS + 10_000)
  engine.click()
  const first = engine.getSnapshot()
  expect(first.act).toBe('love')
  expect(first.hearts).toBe(1)
  engine.click()
  expect(engine.getSnapshot().hearts).toBe(2)
  vi.advanceTimersByTime(1000)
  expect(acts(engine)).not.toBe('love')
  engine.destroy()
})

test('a change of state wakes a sleeper and starts the new mood', () => {
  const engine = pet('idle')
  vi.advanceTimersByTime(SLEEP_AFTER_MS + 10_000)
  expect(acts(engine)).toBe('sleep')
  engine.setMood('needs')
  expect(acts(engine)).toBe('cheer')
  engine.setMood('idle')
  expect(acts(engine)).not.toBe('sleep')
  vi.advanceTimersByTime(1000)
  expect(acts(engine)).not.toBe('sleep')
  engine.destroy()
})

test('attention restarts the sleep clock', () => {
  const engine = pet('idle')
  vi.advanceTimersByTime(SLEEP_AFTER_MS - 5000)
  engine.pointerEnter(0.5)
  engine.pointerLeave()
  vi.advanceTimersByTime(SLEEP_AFTER_MS - 5000)
  expect(acts(engine)).not.toBe('sleep')
  vi.advanceTimersByTime(20_000)
  expect(acts(engine)).toBe('sleep')
  engine.destroy()
})

test('under the pointer a pet stops where it is, faces the pointer and looks at it, until the pointer leaves', () => {
  const engine = pet('thinking')
  expect(engine.getSnapshot().act).toBe('pace')
  engine.pointerEnter(0.31)
  const stopped = engine.getSnapshot()
  expect(stopped.x).toBe(0.31)
  expect(stopped.walkMs).toBe(0)
  expect(stopped.act).toBe('look')
  engine.face('left')
  expect(engine.getSnapshot().facing).toBe('left')
  engine.face('right')
  expect(engine.getSnapshot().facing).toBe('right')
  vi.advanceTimersByTime(60_000)
  expect(engine.getSnapshot().x).toBe(0.31)
  expect(acts(engine)).toBe('look')
  engine.pointerLeave()
  expect(acts(engine)).toBe('pace')
  engine.destroy()
})

test('a busy pet does not say hi, an idle one does', () => {
  const busy = pet('working')
  busy.pointerEnter(0.5)
  expect(busy.getSnapshot().saying).toBe(false)
  busy.destroy()
  const idle = pet('idle')
  idle.pointerEnter(0.5)
  expect(idle.getSnapshot().saying).toBe(true)
  idle.destroy()
})

test('Calm: no walking and no tricks, whatever the state, only the mood and a greeting', () => {
  for (const mood of ['idle', 'working', 'thinking', 'needs'] as const) {
    const engine = pet(mood, 'calm')
    const start = engine.getSnapshot()
    expect(start.act).toBe('rest')
    expect(start.base).toBe(mood)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10 * SLEEP_AFTER_MS)
    expect(engine.getSnapshot().act).toBe('rest')
    expect(engine.getSnapshot().x).toBe(start.x)
    engine.destroy()
  }
})

test('Calm greets the pointer without a hop, and a click is only a greeting', () => {
  const engine = pet('idle', 'calm')
  engine.pointerEnter(0.5)
  expect(engine.getSnapshot().saying).toBe(true)
  expect(engine.getSnapshot().act).toBe('rest')
  vi.advanceTimersByTime(1200)
  expect(engine.getSnapshot().saying).toBe(false)
  engine.pointerLeave()
  engine.click()
  expect(engine.getSnapshot().saying).toBe(true)
  expect(engine.getSnapshot().hearts).toBe(0)
  expect(engine.getSnapshot().act).toBe('rest')
  engine.destroy()
})

test('Still: no motion at all, no timers, and nothing answers the pointer', () => {
  const engine = pet('working', 'still')
  const start = engine.getSnapshot()
  expect(start.act).toBe('rest')
  expect(start.base).toBe('working')
  expect(vi.getTimerCount()).toBe(0)
  engine.pointerEnter(0.2)
  engine.click()
  engine.face('left')
  const after = engine.getSnapshot()
  expect(after.saying).toBe(false)
  expect(after.hearts).toBe(0)
  expect(after.act).toBe('rest')
  expect(after.x).toBe(start.x)
  expect(vi.getTimerCount()).toBe(0)
  engine.destroy()
})

test('changing the liveliness takes effect at once, both ways', () => {
  const engine = pet('idle')
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  engine.setLiveliness('still')
  expect(acts(engine)).toBe('rest')
  expect(vi.getTimerCount()).toBe(0)
  engine.setLiveliness('lively')
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  engine.setLiveliness('calm')
  expect(acts(engine)).toBe('rest')
  expect(vi.getTimerCount()).toBe(0)
  engine.destroy()
})

test('a hidden tab pauses everything: no timers, no acts, and the hours away do not count as inactivity', () => {
  const engine = pet('idle')
  vi.advanceTimersByTime(10_000)
  engine.setHidden(true)
  expect(vi.getTimerCount()).toBe(0)
  const frozen = engine.getSnapshot()
  vi.advanceTimersByTime(60 * 60 * 1000)
  expect(engine.getSnapshot()).toBe(frozen)
  engine.setHidden(false)
  expect(acts(engine)).not.toBe('sleep')
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  vi.advanceTimersByTime(SLEEP_AFTER_MS - 10_000 - 1000)
  expect(acts(engine)).not.toBe('sleep')
  vi.advanceTimersByTime(12_000)
  expect(acts(engine)).toBe('sleep')
  engine.destroy()
})

test('a hidden tab ignores the pointer and a state change until it is shown again', () => {
  const engine = pet('idle')
  engine.setHidden(true)
  engine.setMood('working')
  expect(vi.getTimerCount()).toBe(0)
  engine.setHidden(false)
  expect(engine.getSnapshot().base).not.toBe('needs')
  expect(['walk', 'type', 'stretch']).toContain(acts(engine))
  engine.destroy()
})

test('subscribers hear about every change, and not after destroy', () => {
  const engine = pet('idle')
  const heard = vi.fn()
  const off = engine.subscribe(heard)
  engine.click()
  expect(heard).toHaveBeenCalled()
  off()
  heard.mockClear()
  engine.click()
  expect(heard).not.toHaveBeenCalled()
  engine.destroy()
  expect(vi.getTimerCount()).toBe(0)
})

test('acts that finish on their own ask for no timer when they loop in CSS', () => {
  const engine = pet('needs')
  expect(vi.getTimerCount()).toBe(0)
  engine.destroy()
})
