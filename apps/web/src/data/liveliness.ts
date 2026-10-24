import { useSyncExternalStore } from 'react'

/** How much agents move on this device (Settings › Look). A per-device choice, like the colour mode. */
export type Liveliness = 'calm' | 'still'
export const livelinessChoices: Liveliness[] = ['calm', 'still']
const STORAGE_KEY = 'score.liveliness'
/** Fired on window when this device's choice changes, so the page follows at once. */
export const LIVELINESS_CHANGED = 'score:liveliness-changed'

const REDUCED = '(prefers-reduced-motion: reduce)'

function matches(query: string): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  } catch {
    return false
  }
}

/** What this device chose, or null when it never did. A stored 'lively' (the removed pet-era choice) reads as Calm. */
export function readStoredLiveliness(): Liveliness | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'calm' || value === 'still' ? value : null
  } catch {
    return null
  }
}

/** The choice, or the default: Calm. */
export function readLiveliness(): Liveliness {
  return readStoredLiveliness() ?? 'calm'
}

/** What actually moves: reduced motion is Still whatever was chosen. */
export function effectiveLiveliness(): Liveliness {
  return matches(REDUCED) ? 'still' : readLiveliness()
}

export function saveLiveliness(choice: Liveliness): void {
  try {
    if (choice === 'calm') window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // Blocked storage still applies for this visit only (the event below carries the change).
  }
  window.dispatchEvent(new Event(LIVELINESS_CHANGED))
}

function subscribe(onChange: () => void): () => void {
  const lists = [REDUCED].flatMap((query) => {
    try {
      return typeof window.matchMedia === 'function' ? [window.matchMedia(query)] : []
    } catch {
      return []
    }
  })
  window.addEventListener(LIVELINESS_CHANGED, onChange)
  window.addEventListener('storage', onChange)
  for (const list of lists) list.addEventListener?.('change', onChange)
  return () => {
    window.removeEventListener(LIVELINESS_CHANGED, onChange)
    window.removeEventListener('storage', onChange)
    for (const list of lists) list.removeEventListener?.('change', onChange)
  }
}

/**
 * Mirrors the effective liveliness on the page root (`data-liveliness`), so the stylesheets can stand motion still
 * under Still without each element subscribing. Applied now and again whenever the choice, the screen size or the OS
 * reduced-motion setting changes. Returns the cleanup.
 */
export function watchLiveliness(): () => void {
  const apply = () => {
    document.documentElement.dataset.liveliness = effectiveLiveliness()
  }
  apply()
  return subscribe(apply)
}

/** The effective liveliness for this device, live: a new choice, another tab, a resized window or the OS setting. */
export function useLiveliness(): Liveliness {
  return useSyncExternalStore(subscribe, effectiveLiveliness, () => 'calm')
}

/** The chosen liveliness (what Settings shows), live. */
export function useChosenLiveliness(): Liveliness {
  return useSyncExternalStore(subscribe, readLiveliness, () => 'calm')
}
