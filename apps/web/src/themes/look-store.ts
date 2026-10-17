import { useSyncExternalStore } from 'react'

// Where this device's look choices live (per browser, never sent to the server) and the in-memory state of the
// escape hatches. Storage is wrapped everywhere: private windows and blocked storage must never break the page.

const DEVICE_KEY = 'score.look.device'
const CACHE_KEY = 'score.look.cache'
const LEGACY_PACK_KEY = 'score.look'

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

export function writeDeviceOverride(id: string | null): void {
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

export type LookCache = { id: string; attributes: Record<string, string>; css: string }

export function writeLookCache(cache: LookCache | null): void {
  try {
    if (cache === null) window.localStorage.removeItem(CACHE_KEY)
    else window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // No cache: the next visit paints the default look for a moment.
  }
}

/**
 * "Reset look on this device": the cache and the saved pack go, and this device uses Score's own look whatever the
 * shared theme is (a harmful shared theme must not come straight back). Settings › Look offers "Use the shared theme".
 */
export function clearDeviceLook(): void {
  try {
    window.localStorage.removeItem(CACHE_KEY)
    window.localStorage.removeItem(LEGACY_PACK_KEY)
    window.localStorage.setItem(DEVICE_KEY, 'score')
  } catch {
    // Nothing stored: the reset still holds for this visit.
  }
  state = { ...state, failure: null }
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
}

let state: LookState = { safe: safeFromUrl(), failure: null, device: readDeviceOverride() }
const listeners = new Set<() => void>()

function emit() {
  state = { ...state, device: readDeviceOverride() }
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
    state = { safe, failure: null, device: readDeviceOverride() }
    listeners.forEach((listener) => listener())
  },
}

export function useLookState(): LookState {
  return useSyncExternalStore(lookStore.subscribe, lookStore.get)
}
