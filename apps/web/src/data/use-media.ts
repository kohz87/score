import { createContext, useContext, useSyncExternalStore } from 'react'

/** Breakpoints shared by the whole app (phone < 600, tablet < 1024, desktop >= 1024). */
export const NARROW_QUERY = '(width < 1024px)'
export const PHONE_QUERY = '(width < 600px)'

/** The window whose size the queries measure: the Customizer's preview frame has its own (PLAN 9.4). */
export const MediaWindow = createContext<Window | null>(null)

// jsdom has no matchMedia; treat that as "no match" (desktop layout).
const match = (query: string, win: Window = window) =>
  typeof win.matchMedia === 'function' ? win.matchMedia(query) : null

export function prefersReducedMotion(): boolean {
  return match('(prefers-reduced-motion: reduce)')?.matches ?? false
}

export function useMediaQuery(query: string): boolean {
  const win = useContext(MediaWindow) ?? window
  return useSyncExternalStore(
    (notify) => {
      const list = match(query, win)
      list?.addEventListener('change', notify)
      return () => list?.removeEventListener('change', notify)
    },
    () => match(query, win)?.matches ?? false,
    () => false,
  )
}
