import { useSyncExternalStore } from 'react'
import { forgetStoredTheme } from '../data/theme.ts'

// Where this device's look choices live (per browser, never sent to the server) and the in-memory state of the
// escape hatches. Storage is wrapped everywhere: private windows and blocked storage must never break the page.

const DEVICE_KEY = 'score.look.device'
const CACHE_KEY = 'score.look.cache'
const LEGACY_PACK_KEY = 'score.look'
// The server's reset generation (contract § 16) this device's override and cache were last checked against.
const GENERATION_KEY = 'score.look.generation'

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

/** This device's own theme: `score.look.device`, or the pack an 8.3 Score saved on this device. */
export function readDeviceOverride(): string | null {
  try {
    const value = window.localStorage.getItem(DEVICE_KEY)
    if (value) return ID_PATTERN.test(value) ? value : null
    const legacy = (
      JSON.parse(window.localStorage.getItem(LEGACY_PACK_KEY) || 'null') as {
        pack?: unknown
      } | null
    )?.pack
    return typeof legacy === 'string' && ID_PATTERN.test(legacy) ? legacy : null
  } catch {
    return null
  }
}

/**
 * The in-memory state is what the page applies; storage only carries the choice to the next visit. So the state changes
 * first and a storage that throws (blocked, private window, full) can't stop a choice or a reset (gate finding #9).
 */
export function writeDeviceOverride(id: string | null): void {
  state = { ...state, device: id, choseBeforeList: state.choseBeforeList || !state.generationSeen }
  try {
    if (id === null) {
      window.localStorage.removeItem(DEVICE_KEY)
      window.localStorage.removeItem(LEGACY_PACK_KEY)
    } else window.localStorage.setItem(DEVICE_KEY, id)
  } catch {
    // The choice still applies for this visit.
  }
  emit()
}

type CacheVariant = { attributes: Record<string, string>; css: string; layout?: unknown }
/** Older caches may still carry `user` for the retired /u view; it is accepted and ignored. */
export type LookCache = { id: string; user?: CacheVariant } & CacheVariant

export function writeLookCache(cache: LookCache | null): void {
  try {
    if (cache === null) window.localStorage.removeItem(CACHE_KEY)
    else window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // No cache: the next visit paints the default look for a moment.
  }
}

/**
 * The layout the last applied theme asked for, read before the first render so the menu and the Now cards don't
 * jump when the theme arrives. Same conditions as public/boot-look.js: not in safe mode, not for another device
 * choice.
 */
export function readCachedLayout(): unknown {
  try {
    if (safeFromUrl()) return undefined
    const cache = JSON.parse(window.localStorage.getItem(CACHE_KEY) || 'null') as LookCache | null
    if (!cache || typeof cache !== 'object') return undefined
    const device = window.localStorage.getItem(DEVICE_KEY)
    if (device && cache.id !== device) return undefined
    return cache.layout
  } catch {
    return undefined
  }
}

/**
 * "Reset look on this device": the cache and the saved pack go, and this device uses Score's own look whatever the
 * shared theme is (a harmful shared theme must not come straight back). Settings › Look offers "Use the shared theme".
 */
export function clearDeviceLook(): void {
  state = {
    ...state,
    device: 'score',
    failure: null,
    choseBeforeList: state.choseBeforeList || !state.generationSeen,
  }
  try {
    window.localStorage.removeItem(CACHE_KEY)
    window.localStorage.removeItem(LEGACY_PACK_KEY)
    window.localStorage.setItem(DEVICE_KEY, 'score')
  } catch {
    // Nothing stored: the reset still holds for this visit.
  }
  emit()
}

function readStoredGeneration(): number {
  try {
    const value = Number(window.localStorage.getItem(GENERATION_KEY) ?? 0)
    return Number.isInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

/**
 * `scripts/score look reset` bumps the server's reset generation. A device that last saw another number drops its own
 * theme and the boot cache and remembers the new number, so the host reset reaches browsers that kept an override
 * (gate finding #10). The in-memory state changes first, like every reset here (finding #9). The device's light/dark
 * choice (`score.theme`) goes with them, or a stored "dark" would override the mode the host reset to (re-gate #9).
 */
export function applyResetGeneration(generation: number): void {
  const first = !state.generationSeen
  if (first) state = { ...state, generationSeen: true }
  if (generation === state.generation) return
  // A choice made on this page before the server's number was known (Ctrl+Shift+0, the guard's fallback) is newer than
  // any host reset the number can speak of: the device adopts the number and keeps the choice (cross-audit X15). A reset
  // that comes after this first reading is a real one and still drops it.
  if (first && state.choseBeforeList) {
    state = { ...state, generation }
    try {
      window.localStorage.setItem(GENERATION_KEY, String(generation))
    } catch {
      // The choice still holds for this visit.
    }
    emit()
    return
  }
  state = { ...state, device: null, generation }
  forgetStoredTheme()
  try {
    window.localStorage.removeItem(DEVICE_KEY)
    window.localStorage.removeItem(LEGACY_PACK_KEY)
    window.localStorage.removeItem(CACHE_KEY)
    window.localStorage.setItem(GENERATION_KEY, String(generation))
  } catch {
    // The drop still holds for this visit.
  }
  emit()
}

function safeFromUrl(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('look') === 'safe'
  } catch {
    return false
  }
}

export type LookState = {
  /** `?look=safe` on this page load: theme and override are off until the page is reloaded. */
  safe: boolean
  /** Why the theme was skipped (it threw, was refused or damaged a protected surface); null when all is well. */
  failure: string | null
  device: string | null
  /** The server reset generation this device's saved look was last checked against. */
  generation: number
  /** This page has read the server's reset generation at least once (not persisted). */
  generationSeen: boolean
  /** The device's look was chosen on this page before the server's generation was known (not persisted). */
  choseBeforeList: boolean
}

let state: LookState = {
  safe: safeFromUrl(),
  failure: null,
  device: readDeviceOverride(),
  generation: readStoredGeneration(),
  generationSeen: false,
  choseBeforeList: false,
}
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

export const lookStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  setFailure(failure: string | null) {
    if (state.failure === failure) return
    state = { ...state, failure }
    listeners.forEach((listener) => listener())
  },
  /** Tests: back to a fresh page load. */
  reset(safe = false) {
    state = {
      safe,
      failure: null,
      device: readDeviceOverride(),
      generation: readStoredGeneration(),
      generationSeen: false,
      choseBeforeList: false,
    }
    listeners.forEach((listener) => listener())
  },
}

export function useLookState(): LookState {
  return useSyncExternalStore(lookStore.subscribe, lookStore.get)
}
