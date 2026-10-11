import { useEffect, useRef, useState } from 'react'
import type { Chip } from './resolved.ts'

export interface Resolved {
  id: string
  label: string
  chip: Chip
}

/** How long a decided card stays as a chip where it was. */
export const RESOLVED_MS = 8000

/**
 * Cards that wait for the person leave the list when they are decided. This remembers the ones that just left, as chips
 * for a short while (PLAN 5.39). `resolve` reads the outcome of an id that is no longer open; null means it wasn't a
 * decision (the run ended, the card was withdrawn) and nothing is shown.
 */
export function useRecentlyResolved(
  openIds: ReadonlySet<string>,
  resolve: (id: string) => Omit<Resolved, 'id'> | null,
  ms = RESOLVED_MS,
): Resolved[] {
  const previous = useRef<ReadonlySet<string>>(openIds)
  const read = useRef(resolve)
  const timers = useRef(new Set<number>())
  const [recent, setRecent] = useState<Resolved[]>([])
  useEffect(() => {
    read.current = resolve
  })
  // The set itself is new on every render; what matters is which ids are in it.
  const key = [...openIds].sort().join('\u0000')
  useEffect(() => {
    const before = previous.current
    previous.current = openIds
    const added = [...before]
      .filter((id) => !openIds.has(id))
      .flatMap((id) => {
        const outcome = read.current(id)
        return outcome ? [{ id, ...outcome }] : []
      })
    if (added.length === 0) return
    setRecent((list) => [...list.filter((item) => !added.some((a) => a.id === item.id)), ...added])
    const timer = window.setTimeout(() => {
      timers.current.delete(timer)
      setRecent((list) => list.filter((item) => !added.some((a) => a.id === item.id)))
    }, ms)
    timers.current.add(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the content of `openIds`
  }, [key, ms])
  useEffect(() => {
    const live = timers.current
    return () => {
      live.forEach((timer) => window.clearTimeout(timer))
      live.clear()
    }
  }, [])
  return recent
}
