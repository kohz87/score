import { useSyncExternalStore } from 'react'

/** Breakpoints shared by the whole app (phone < 600, tablet < 1024, desktop >= 1024). */
export const NARROW_QUERY = '(width < 1024px)'
export const PHONE_QUERY = '(width < 600px)'

// jsdom has no matchMedia; treat that as "no match" (desktop layout).
const match = (query: string) =>
  typeof window.matchMedia === 'function' ? window.matchMedia(query) : null

export function prefersReducedMotion(): boolean {
  return match('(prefers-reduced-motion: reduce)')?.matches ?? false
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = match(query)
      list?.addEventListener('change', notify)
      return () => list?.removeEventListener('change', notify)
    },
    () => match(query)?.matches ?? false,
    () => false,
  )
}
