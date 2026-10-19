import { useSyncExternalStore } from 'react'

/** How much agents move on this device (Settings › Look): pet avatars and marks. A per-device choice, like the colour mode. */
export type Liveliness = 'lively' | 'calm' | 'still'
export const livelinessChoices: Liveliness[] = ['lively', 'calm', 'still']
const STORAGE_KEY = 'score.liveliness'
/** Fired on window when this device's choice changes, so the pets and marks on the page follow at once. */
export const LIVELINESS_CHANGED = 'score:liveliness-changed'

const PHONE = '(max-width: 599px)'
const REDUCED = '(prefers-reduced-motion: reduce)'

function matches(query: string): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  } catch {
    return false
  }
}

/** What this device chose, or null when it never did (Lively on a desk, Calm on a phone). */
export function readStoredLiveliness(): Liveliness | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'lively' || value === 'calm' || value === 'still' ? value : null
  } catch {
    return null
  }
}

/** The choice, or the default: Lively, except Calm on a phone-width screen that never chose. */
export function readLiveliness(): Liveliness {
  return readStoredLiveliness() ?? (matches(PHONE) ? 'calm' : 'lively')
}

/** What the pets actually do: reduced motion is Still whatever was chosen. */
export function effectiveLiveliness(): Liveliness {
  return matches(REDUCED) ? 'still' : readLiveliness()
}

export function saveLiveliness(choice: Liveliness): void {
  try {
    if (choice === 'lively') window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // Blocked storage still applies for this visit only (the event below carries the change).
  }
  // Lively is the stored default only on a desk; on a phone it must be remembered as a choice.
  if (choice === 'lively' && matches(PHONE)) {
    try {
      window.localStorage.setItem(STORAGE_KEY, choice)
    } catch {
      // As above.
    }
  }
  window.dispatchEvent(new Event(LIVELINESS_CHANGED))
}

function subscribe(onChange: () => void): () => void {
  const lists = [PHONE, REDUCED].flatMap((query) => {
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
 * Mirrors the effective liveliness on the page root (`data-liveliness`), so the stylesheets can stand every mark still
 * under Still without each mark subscribing. Applied now and again whenever the choice, the screen size or the OS
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
  return useSyncExternalStore(subscribe, effectiveLiveliness, () => 'lively')
}

/** The chosen liveliness (what Settings shows), live. */
export function useChosenLiveliness(): Liveliness {
  return useSyncExternalStore(subscribe, readLiveliness, () => 'lively')
}
