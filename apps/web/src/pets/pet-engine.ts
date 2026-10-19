import type { AgentActivity, AgentPose } from '../components/AgentGlyph.tsx'
import type { Liveliness } from '../data/liveliness.ts'

// The behaviour of one pet corner (PLAN 10.2c, decision 106). Pure scheduling, no DOM and no animation frames: it
// decides which act the pet is in and for how long, and the corner turns each act into a CSS class. Reference:
// the approved preview's engine (act, walkTo, next).

/** The agent's mood, which is what the rest of Score already shows for it. */
export type PetMood = AgentActivity

export type PetAct =
  | 'rest' // Calm and Still: just the mood
  | 'walk'
  | 'look'
  | 'sit'
  | 'stretch'
  | 'yawn'
  | 'hop'
  | 'sleep'
  | 'greet'
  | 'love'
  | 'type'
  | 'pace'
  | 'ponder'
  | 'cheer'

/** The mood a glyph is drawn in for each act (a greeting reuses "needs you" for its open mouth and wide eyes). */
export const actBase: Record<Exclude<PetAct, 'rest'>, PetMood> = {
  walk: 'idle',
  look: 'idle',
  sit: 'idle',
  stretch: 'idle',
  yawn: 'idle',
  hop: 'idle',
  sleep: 'idle',
  greet: 'needs',
  love: 'idle',
  type: 'working',
  pace: 'thinking',
  ponder: 'thinking',
  cheer: 'needs',
}

/** Idle acts and their weights. */
export const idleChoices: ReadonlyArray<readonly [PetAct, number]> = [
  ['walk', 34],
  ['look', 18],
  ['sit', 16],
  ['stretch', 10],
  ['yawn', 10],
  ['hop', 12],
]

/** An idle pet with nobody paying attention goes to sleep after this long. */
export const SLEEP_AFTER_MS = 25_000
const GREET_MS = 900
const SAY_MS = 1100
const LOVE_MS = 900
// Walking speeds in pixels per second: a stroll, a purposeful walk to the desk, a slow pace.
const STROLL = 46
const TO_DESK = 70
const PACE = 26
const DESK = 0.5
// A pet stays between these fractions of the corner's width.
const LEFT_EDGE = 0.18
const RIGHT_EDGE = 0.82

export type PetSnapshot = {
  act: PetAct
  /** The mood the glyph is drawn in. */
  base: PetMood
  pose?: AgentPose
  /** Centre of the pet as a fraction of the corner's width. */
  x: number
  facing: 'left' | 'right'
  /** How long the walk to `x` takes; 0 means jump (a pet stopping under the pointer). */
  walkMs: number
  saying: boolean
  /** Counts hearts so each click can start one more. */
  hearts: number
  /** Counts acts so a repeated one-shot act (hop, hop) can restart its animation. */
  step: number
}

export type PetEngine = {
  start: () => void
  destroy: () => void
  getSnapshot: () => PetSnapshot
  subscribe: (listener: () => void) => () => void
  setMood: (mood: PetMood) => void
  setLiveliness: (liveliness: Liveliness) => void
  /** The tab is hidden: no timers run until it is shown again. */
  setHidden: (hidden: boolean) => void
  /** The pointer entered the corner; `x` is where the pet is right now, as a fraction of the corner's width. */
  pointerEnter: (x: number) => void
  pointerLeave: () => void
  /** While the pointer is over the corner the pet turns to face it. */
  face: (direction: 'left' | 'right') => void
  /** `x` is where the pet is right now, so a click does not make it jump to where it was walking. */
  click: (x?: number) => void
}

export type PetEngineOptions = {
  mood: PetMood
  liveliness: Liveliness
  random?: () => number
  /** The corner's width in pixels, for the length of a walk. */
  width?: () => number
}

const clampX = (x: number) => Math.min(RIGHT_EDGE + 0.1, Math.max(LEFT_EDGE - 0.1, x))

export function createPetEngine(options: PetEngineOptions): PetEngine {
  const random = options.random ?? Math.random
  const width = options.width ?? (() => 240)
  let mood = options.mood
  let liveliness = options.liveliness
  let hidden = false
  let hovered = false
  let started = false
  let hiddenAt = 0
  let lastAttention = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let sayTimer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  let snapshot: PetSnapshot = {
    act: 'rest',
    base: mood,
    x: DESK,
    facing: 'right',
    walkMs: 0,
    saying: false,
    hearts: 0,
    step: 0,
  }

  function emit(change: Partial<PetSnapshot>) {
    snapshot = { ...snapshot, ...change }
    for (const listener of [...listeners]) listener()
  }

  function clearTimers() {
    clearTimeout(timer)
    clearTimeout(sayTimer)
    timer = undefined
    sayTimer = undefined
  }

  function act(name: PetAct, ms: number | null, change: Partial<PetSnapshot> = {}) {
    clearTimeout(timer)
    timer = undefined
    emit({
      act: name,
      base: name === 'rest' ? mood : actBase[name],
      pose: name === 'sleep' ? 'sleep' : name === 'yawn' ? 'yawn' : undefined,
      walkMs: 0,
      step: snapshot.step + 1,
      ...change,
    })
    // An act with no end (sleeping, a mood that loops in CSS) waits for an event instead of a timer.
    if (ms !== null) timer = setTimeout(next, ms)
  }

  function walkTo(x: number, speed: number, name: PetAct) {
    const from = snapshot.x
    const ms = Math.max(300, ((Math.abs(x - from) * width()) / speed) * 1000)
    act(name, ms, {
      x,
      walkMs: ms,
      facing: x < from ? 'left' : x > from ? 'right' : snapshot.facing,
    })
  }

  function pick(roll: number): PetAct {
    const total = idleChoices.reduce((sum, [, weight]) => sum + weight, 0)
    let remaining = roll * total
    for (const [name, weight] of idleChoices) {
      remaining -= weight
      if (remaining < 0) return name
    }
    return idleChoices[0]![0]
  }

  function say() {
    clearTimeout(sayTimer)
    emit({ saying: true })
    sayTimer = setTimeout(() => {
      sayTimer = undefined
      emit({ saying: false })
    }, SAY_MS)
  }

  function next() {
    timer = undefined
    if (hidden || !started) return
    // Two draws every time, whatever the mood, so a seeded run is easy to follow.
    const roll = random()
    const vary = random()
    if (liveliness !== 'lively') return act('rest', null)
    if (hovered) return act('look', null, { base: mood })
    if (mood === 'needs') return act('cheer', null)
    if (mood === 'working') {
      if (Math.abs(snapshot.x - DESK) > 0.02) return walkTo(DESK, TO_DESK, 'walk')
      return roll < 0.15 ? act('stretch', 1400) : act('type', 4000 + vary * 4000)
    }
    if (mood === 'thinking') {
      if (snapshot.act === 'pace') return act('ponder', 1600 + vary * 1600)
      return walkTo(0.2 + vary * 0.6, PACE, 'pace')
    }
    if (Date.now() - lastAttention > SLEEP_AFTER_MS) return act('sleep', null)
    const choice = pick(roll)
    if (choice === 'walk')
      return walkTo(LEFT_EDGE + vary * (RIGHT_EDGE - LEFT_EDGE), STROLL, 'walk')
    if (choice === 'look') return act('look', 2200)
    if (choice === 'sit') return act('sit', 3000 + vary * 3000)
    if (choice === 'stretch') return act('stretch', 1400)
    if (choice === 'yawn') return act('yawn', 1600)
    return act('hop', 800)
  }

  return {
    start() {
      if (started) return
      started = true
      lastAttention = Date.now()
      next()
    },
    destroy() {
      // Stops the clock; a React strict-mode remount may start it again.
      started = false
      clearTimers()
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setMood(value) {
      if (value === mood) return
      mood = value
      lastAttention = Date.now()
      if (hidden || !started) return emit({ base: liveliness === 'lively' ? snapshot.base : mood })
      // A new state is news: the pet drops what it was doing (and wakes up) for it.
      next()
    },
    setLiveliness(value) {
      if (value === liveliness) return
      liveliness = value
      lastAttention = Date.now()
      clearTimers()
      emit({ saying: false })
      if (started) next()
    },
    setHidden(value) {
      if (value === hidden) return
      hidden = value
      if (value) {
        hiddenAt = Date.now()
        clearTimers()
        return
      }
      // Time away is not time without attention.
      lastAttention += Date.now() - hiddenAt
      if (started) next()
    },
    pointerEnter(x) {
      hovered = true
      lastAttention = Date.now()
      if (hidden || !started || liveliness === 'still') return
      if (liveliness === 'calm') return say()
      const wasAsleep = snapshot.act === 'sleep'
      const stop = { x: clampX(x), walkMs: 0 }
      if (mood === 'idle' || wasAsleep) {
        // Say hi: stop, hop once, and speak.
        act('greet', GREET_MS, stop)
        say()
      } else {
        act('look', null, { ...stop, base: mood })
      }
    },
    pointerLeave() {
      if (!hovered) return
      hovered = false
      lastAttention = Date.now()
      if (hidden || !started) return
      if (liveliness === 'lively') next()
    },
    face(direction) {
      if (!hovered || liveliness !== 'lively' || snapshot.facing === direction) return
      emit({ facing: direction })
    },
    click(x) {
      lastAttention = Date.now()
      if (hidden || !started || liveliness === 'still') return
      if (liveliness === 'calm') return say()
      act('love', LOVE_MS, {
        hearts: snapshot.hearts + 1,
        ...(x === undefined ? {} : { x: clampX(x) }),
      })
    },
  }
}
