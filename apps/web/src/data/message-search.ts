import { useEffect, useState } from 'react'

/** Waits for typing to pause before it is used, so the server is asked once per word rather than per key. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}
