import { useEffect, useState } from 'react'

/** A room with nothing new for this long lets its members nap (PLAN 10.10). */
export const QUIET_MS = 5 * 60_000

/**
 * True once `signature` (a summary of the room's messages, typing and approvals) has not changed for five minutes.
 * Any change wakes the room at once and starts the five minutes again.
 */
export function useQuiet(signature: string): boolean {
  const [quiet, setQuiet] = useState(false)
  const [seen, setSeen] = useState(signature)
  if (seen !== signature) {
    setSeen(signature)
    setQuiet(false)
  }
  useEffect(() => {
    const timer = setTimeout(() => setQuiet(true), QUIET_MS)
    return () => clearTimeout(timer)
  }, [signature])
  return quiet
}
