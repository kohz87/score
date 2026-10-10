import { useSyncExternalStore } from 'react'

/** "Show deleted messages" per room (PLAN 5.35): off by default and only for this tab, like a view filter. */
const shown = new Set<string>()
const listeners = new Set<() => void>()

export function setShowDeleted(roomId: string, value: boolean) {
  if (value === shown.has(roomId)) return
  if (value) shown.add(roomId)
  else shown.delete(roomId)
  listeners.forEach((listener) => listener())
}

export function useShowDeleted(roomId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => shown.has(roomId),
    () => false,
  )
}
