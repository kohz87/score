import { useEffect, useState } from 'react'

// PLAN 5.37: the one gate for every anime.js animation. Reduced motion means no animation at all (the final state is
// simply there); motion explains a state change and is never the only carrier of information.

export type Anime = typeof import('./anime.ts')

const QUERY = '(prefers-reduced-motion: reduce)'

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY).matches
    : false
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(QUERY)
    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

let loading: Promise<Anime> | undefined
/** Loads anime.js once, as a separate chunk. */
export function loadAnime(): Promise<Anime> {
  loading ??= import('./anime.ts')
  return loading
}

/**
 * Runs `play` with anime.js unless the user prefers reduced motion. `play` returns a cleanup (usually reverting what it
 * started). The returned function cancels: if the library has not loaded yet, `play` never runs.
 */
export function playMotion(play: (anime: Anime) => (() => void) | void): () => void {
  if (prefersReducedMotion()) return () => {}
  let cancelled = false
  let cleanup: (() => void) | void
  void loadAnime().then(
    (anime) => {
      if (cancelled || prefersReducedMotion()) return
      // Motion never breaks the page (an environment without the Web Animations API, say): no motion, final state.
      try {
        cleanup = play(anime)
      } catch {
        cleanup = undefined
      }
    },
    () => {}, // no library, no motion: the final state is already on screen
  )
  return () => {
    cancelled = true
    cleanup?.()
  }
}

/** The motion rhythm: calm, 300–600 ms. */
export const MOTION = { fast: 320, base: 450, slow: 600, stagger: 90, ease: 'outQuad' } as const

let busy = 0
/**
 * Marks the page while a script-driven change of text or layout is under way (a count-up). Tests and screenshots wait
 * for `html[data-motion]` to go away so they read the final state. Returns the function that ends the mark.
 */
export function markMotionBusy(): () => void {
  if (typeof document === 'undefined') return () => {}
  busy++
  document.documentElement.dataset.motion = 'busy'
  let done = false
  return () => {
    if (done) return
    done = true
    busy--
    if (busy === 0) delete document.documentElement.dataset.motion
  }
}
