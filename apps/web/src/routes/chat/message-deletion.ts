import { useSyncExternalStore } from 'react'
import { apiFetch } from '../../data/api.ts'

// Delete is optimistic and undoable (PLAN 5.20): the message hides at once, the DELETE is sent only when the undo
// window ends. The timers live at module level so leaving the page does not drop a delete the person confirmed.
export const UNDO_MS = 6_000

interface Pending {
  roomId: string
  timer: ReturnType<typeof setTimeout>
}
let pending = new Map<string, Pending>()
// Deleted for real: stays hidden until the stream's message.deleted reaches the cache (and after a reload the
// server no longer returns it).
const confirmed = new Set<string>()
// The undo window has closed and the DELETE is on its way: still hidden, but Undo is gone (it could not stop the request).
const sending = new Set<string>()
let failed: string | null = null
const listeners = new Set<() => void>()
let snapshot = { ids: new Set<string>(), hidden: new Set<string>(), failed: null as string | null }
function publish() {
  snapshot = {
    ids: new Set(pending.keys()),
    hidden: new Set([...pending.keys(), ...sending, ...confirmed]),
    failed,
  }
  for (const listener of listeners) listener()
}

export function requestDelete(roomId: string, messageId: string): void {
  if (pending.has(messageId) || sending.has(messageId)) return
  failed = null
  const timer = setTimeout(() => {
    pending.delete(messageId)
    sending.add(messageId)
    publish()
    void (async () => {
      try {
        await apiFetch(
          `rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`,
          { method: 'DELETE' },
        )
        confirmed.add(messageId)
      } catch {
        // The message comes back; the person is told once.
        failed = 'Could not delete the message. It is back in the conversation.'
      }
      sending.delete(messageId)
      publish()
    })()
  }, UNDO_MS)
  pending.set(messageId, { roomId, timer })
  publish()
}

export function undoDelete(messageId: string): void {
  const entry = pending.get(messageId)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(messageId)
  publish()
}

export function dismissDeleteFailure(): void {
  failed = null
  publish()
}

/** Test hook: drops all state without sending anything. */
export function resetMessageDeletion(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending = new Map()
  sending.clear()
  confirmed.clear()
  failed = null
  publish()
}

export function usePendingDeletes() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot,
  )
}
