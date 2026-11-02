import { createContext, useContext, useSyncExternalStore } from 'react'

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
