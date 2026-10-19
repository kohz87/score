import type { PetActivity } from '@score/contract'
import type { Liveliness } from '../data/liveliness.ts'

// What a pet avatar plays and when (PLAN 10.2, decisions 107–108). Pure scheduling, no DOM: it decides which of the
// pack's files is showing and which of Score's overlays stand in for a file the pack doesn't have; the component draws
// it. Lively adds idle extras (a stroll, a stretch, a coffee, a book) and sleep after a while without attention; Calm
// keeps to the mood plus the greeting and the happy bounce; Still moves nothing.

/** The agent's mood, which is what the rest of Score already shows for it. */
export type PetMood = 'idle' | 'working' | 'thinking' | 'needs'

export type PetOverlay = 'dots' | 'alert' | 'zzz'

export type PetView = {
  /** The pack file showing now; always one the pack has. */
  file: PetActivity
  /** Score's stand-in for a mood the pack has no file for (on `idle`): thought dots, a "!" and a hop, sleeping z's. */
  overlay: PetOverlay | null
  /** The "!" fallback hops. */
  hop: boolean
  /** "hi!" while the pointer is over it, when the pack has no `greet`. */
  saying: boolean
  /** A heart rises and the pet bounces when it is clicked, when the pack has no `happy`. */
  love: boolean
  /** Counts hearts so each click can start one more. */
  hearts: number
}

/** The files a mood plays when the pack has them. */
export const moodFile: Record<PetMood, PetActivity> = {
  idle: 'idle',
  working: 'work',
  thinking: 'think',
  needs: 'needs',
}

/** Breaks the pet takes, and how long each plays before it is back at rest. */
export const extraMs = { walk: 6000, stretch: 3500, coffee: 5000, read: 7000 } as const
type Extra = keyof typeof extraMs

/** An idle pet that nobody has paid attention to goes to sleep after this long. */
export const SLEEP_AFTER_MS = 25_000
/** A break starts somewhere in this window after the last thing ended. */
export const EXTRA_EVERY_MS: readonly [number, number] = [9000, 20000]
export const GREET_MS = 1200
export const HAPPY_MS = 1200

export type PetScheduler = {
  getSnapshot: () => PetView
  subscribe: (listener: () => void) => () => void
  setMood: (mood: PetMood) => void
  setLiveliness: (liveliness: Liveliness) => void
  /** The files the pack has (a new revision can change them). */
  setActivities: (activities: ReadonlySet<PetActivity>) => void
  /** The tab is hidden: no timers run until it is shown again. */
  setHidden: (hidden: boolean) => void
  pointerEnter: () => void
  click: () => void
  /** Starts the timers (a pet that is not mounted has none); `destroy` stops them and can be followed by `start`. */
  start: () => void
  destroy: () => void
}

export type PetSchedulerOptions = {
  mood: PetMood
  liveliness: Liveliness
  activities: ReadonlySet<PetActivity>
  random?: () => number
}

const extrasFor = (mood: PetMood): readonly Extra[] =>
  mood === 'idle'
    ? ['walk', 'stretch', 'coffee', 'read']
    : mood === 'working'
      ? ['stretch', 'coffee', 'read']
      : []

export function createPetScheduler(options: PetSchedulerOptions): PetScheduler {
  const random = options.random ?? Math.random
  let mood = options.mood
  let liveliness = options.liveliness
  let activities = options.activities
  let hidden = false
  let extra: Extra | null = null
  let sleeping = false
  let greeting = false
  let happy = false
  let hearts = 0
  // When anyone last looked (or the mood last changed): sleep is counted from here, not from the end of a break.
  let lookedAt = Date.now()
  const listeners = new Set<() => void>()
  // The next break, the nap, and the two short moments (the greeting, the happy bounce): one timer each.
  let breakTimer: ReturnType<typeof setTimeout> | undefined
  let sleepTimer: ReturnType<typeof setTimeout> | undefined
  let greetTimer: ReturnType<typeof setTimeout> | undefined
  let happyTimer: ReturnType<typeof setTimeout> | undefined

  const has = (activity: PetActivity) => activities.has(activity)

  function compute(): PetView {
    const base = (file: PetActivity, overlay: PetOverlay | null = null, hop = false): PetView => ({
      file,
      overlay,
      hop,
      saying: greeting && !has('greet'),
      love: happy && !has('happy'),
      hearts,
    })
    if (happy && has('happy')) return base('happy')
    if (greeting && has('greet')) return base('greet')
    if (sleeping) return has('sleep') ? base('sleep') : base('idle', 'zzz')
    if (extra && has(extra)) return base(extra)
    const wanted = moodFile[mood]
    if (wanted === 'idle' || has(wanted)) return base(wanted)
    if (mood === 'thinking') return base('idle', 'dots')
    if (mood === 'needs') return base('idle', 'alert', true)
    return base('idle')
  }

  let view: PetView = compute()

  function publish() {
    const next = compute()
    if (JSON.stringify(next) === JSON.stringify(view)) return
    view = next
    for (const listener of listeners) listener()
  }

  const between = ([low, high]: readonly [number, number]) => low + random() * (high - low)

  function disarm() {
    clearTimeout(breakTimer)
    clearTimeout(sleepTimer)
    breakTimer = undefined
    sleepTimer = undefined
  }

  /** What happens next while nobody is looking: a break, or sleep when it is long enough since anyone looked. */
  function arm() {
    disarm()
    if (hidden || liveliness !== 'lively' || sleeping) return
    if (extra) {
      breakTimer = setTimeout(() => {
        extra = null
        publish()
        arm()
      }, extraMs[extra])
    } else {
      const choices = extrasFor(mood).filter((name) => has(name))
      if (choices.length > 0)
        breakTimer = setTimeout(() => {
          extra = choices[Math.floor(random() * choices.length)] ?? null
          publish()
          arm()
        }, between(EXTRA_EVERY_MS))
    }
    if (mood === 'idle')
      sleepTimer = setTimeout(
        () => {
          extra = null
          sleeping = true
          disarm()
          publish()
        },
        Math.max(0, lookedAt + SLEEP_AFTER_MS - Date.now()),
      )
  }

  /** Someone is paying attention, or the mood changed: wake up and start the waiting again. */
  function attention() {
    sleeping = false
    extra = null
    lookedAt = Date.now()
    arm()
  }

  return {
    getSnapshot: () => view,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setMood(next) {
      if (next === mood) return
      mood = next
      attention()
      publish()
    },
    setLiveliness(next) {
      if (next === liveliness) return
      liveliness = next
      if (next === 'still') {
        greeting = false
        happy = false
        clearTimeout(greetTimer)
        clearTimeout(happyTimer)
      }
      attention()
      publish()
    },
    setActivities(next) {
      activities = next
      if (extra && !has(extra)) extra = null
      arm()
      publish()
    },
    setHidden(next) {
      if (next === hidden) return
      hidden = next
      if (hidden) disarm()
      else attention()
    },
    pointerEnter() {
      if (liveliness === 'still') return
      attention()
      greeting = true
      clearTimeout(greetTimer)
      greetTimer = setTimeout(() => {
        greeting = false
        publish()
      }, GREET_MS)
      publish()
    },
    click() {
      if (liveliness === 'still') return
      attention()
      happy = true
      hearts += 1
      clearTimeout(happyTimer)
      happyTimer = setTimeout(() => {
        happy = false
        publish()
      }, HAPPY_MS)
      publish()
    },
    start() {
      attention()
    },
    destroy() {
      disarm()
      clearTimeout(greetTimer)
      clearTimeout(happyTimer)
    },
  }
}
