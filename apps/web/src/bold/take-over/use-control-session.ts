import { useCallback, useEffect, useRef } from 'react'
import type { BotInputEvent } from '@score/contract'
import { ApiError, apiFetch } from '../../data/api.ts'
import { InputBatcher } from './batcher.ts'

export const SEND_EVERY_MS = 50
export const HEARTBEAT_EVERY_MS = 10_000
export const IDLE_SECONDS = 300

const path = (agentId: string, leaf: string) =>
  `agents/${encodeURIComponent(agentId)}/bot-screen/${leaf}`

/** Hand back that survives the page going away (sendBeacon can't set the web-client header). Errors are ignored. */
function handBackNow(agentId: string, takeoverId: string) {
  try {
    void fetch(`/api/${path(agentId, 'hand-back')}`, {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'X-Score-Client': 'web', 'content-type': 'application/json' },
      body: JSON.stringify({ takeoverId }),
    }).catch(() => undefined)
  } catch {
    /* nothing more to do while the page is closing */
  }
}

export type ControlSession = {
  /** Queue input events; they go out in batches. Nothing is kept, logged or stored. */
  push: (...events: BotInputEvent[]) => void
  /** Hands control back and resolves when the server has answered (or failed). */
  handBack: () => Promise<void>
  /** When this page last sent input (local clock); the idle countdown counts from here. */
  lastInputAt: { current: number }
}

/**
 * Everything that happens while this page holds control: 50 ms input batches (never retried; a 409 means control is
 * gone), a heartbeat every 10 s, and handing back when the page hides, closes or unmounts.
 */
export function useControlSession(
  agentId: string,
  takeoverId: string | undefined,
  onLost: () => void,
): ControlSession {
  const batcher = useRef(new InputBatcher())
  const stopped = useRef(true)
  const handed = useRef(false)
  const lastInputAt = useRef(0)
  const lost = useRef(onLost)
  useEffect(() => {
    lost.current = onLost
  }, [onLost])

  useEffect(() => {
    if (!takeoverId) return
    const queue = batcher.current
    queue.clear()
    stopped.current = false
    handed.current = false
    lastInputAt.current = Date.now()
    let busy = false

    const end = () => {
      stopped.current = true
      queue.clear()
    }
    const gone = (error: unknown) => {
      if (error instanceof ApiError && error.status === 409 && !stopped.current) {
        end()
        lost.current()
      }
    }
    const flush = async () => {
      if (busy || stopped.current || queue.size === 0) return
      const events = queue.take()
      busy = true
      lastInputAt.current = Date.now()
      try {
        await apiFetch(path(agentId, 'input'), {
          method: 'POST',
          body: JSON.stringify({ takeoverId, events }),
        })
      } catch (error) {
        // Never retried: a batch that failed is dropped, a 409 ends control.
        gone(error)
      } finally {
        busy = false
      }
    }
    const beat = async () => {
      if (stopped.current) return
      try {
        await apiFetch(path(agentId, 'heartbeat'), {
          method: 'POST',
          body: JSON.stringify({ takeoverId }),
        })
      } catch (error) {
        gone(error)
      }
    }
    const leave = () => {
      if (handed.current) return
      handed.current = true
      end()
      handBackNow(agentId, takeoverId)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') leave()
    }

    const sender = setInterval(() => void flush(), SEND_EVERY_MS)
    const heart = setInterval(() => void beat(), HEARTBEAT_EVERY_MS)
    window.addEventListener('pagehide', leave)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(sender)
      clearInterval(heart)
      window.removeEventListener('pagehide', leave)
      document.removeEventListener('visibilitychange', onVisibility)
      leave()
    }
  }, [agentId, takeoverId])

  const push = useCallback((...events: BotInputEvent[]) => {
    if (!stopped.current) batcher.current.push(...events)
  }, [])

  const handBack = useCallback(async () => {
    if (!takeoverId || handed.current) return
    handed.current = true
    stopped.current = true
    batcher.current.clear()
    try {
      await apiFetch(path(agentId, 'hand-back'), {
        method: 'POST',
        body: JSON.stringify({ takeoverId }),
      })
    } catch {
      /* control may already be gone; the status read that follows tells the truth */
    }
  }, [agentId, takeoverId])

  return { push, handBack, lastInputAt }
}
