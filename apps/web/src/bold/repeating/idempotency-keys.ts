import { useRef } from 'react'
import { newId } from '../../data/ids.ts'

/**
 * One Idempotency-Key per action until it succeeds (decision 183): a second click after a failed or lost response sends
 * the same key, so the server answers once, and after success the next action gets a new one. A key is tied to the
 * action's name and body: an action whose body changed in between (the person edited the form) is a different action.
 */
export function useIdempotencyKeys() {
  const slots = useRef(new Map<string, { sig: string; key: string }>())
  return {
    take(name: string, body?: unknown) {
      const sig = JSON.stringify(body ?? null)
      const held = slots.current.get(name)
      if (held && held.sig === sig) return held.key
      const key = newId()
      slots.current.set(name, { sig, key })
      return key
    },
    done(name: string) {
      slots.current.delete(name)
    },
  }
}
