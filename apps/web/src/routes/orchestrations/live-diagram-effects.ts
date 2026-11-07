import { useCallback, useEffect, useRef, useState } from 'react'
import { EffectQueue, type Effect } from './orch-model.ts'

/** Each effect starts at least this long after the previous one (owner: dots paced at 300 ms or more). */
export const EFFECT_GAP_MS = 300
const DOT_MS = 800
const PULSE_MS = 900

export type ActiveEffect = { key: number; effect: Effect; durationMs: number }

/**
 * Plays queued effects one at a time with a minimum gap. With reduced motion a dot does not travel: the edge and both
 * nodes are highlighted instead for the same time. Returns what is on screen right now.
 */
export function useEffectPlayer(reducedMotion: boolean, gapMs = EFFECT_GAP_MS) {
  const queue = useRef(new EffectQueue(gapMs))
  const [active, setActive] = useState<ActiveEffect[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const counter = useRef(0)
  const alive = useRef(true)
  const reduced = useRef(reducedMotion)
  useEffect(() => {
    reduced.current = reducedMotion
  }, [reducedMotion])

  const pump = useCallback(function pump() {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    if (!alive.current) return
    const now = performance.now()
    const next = queue.current.take(now)
    if (next) {
      const key = ++counter.current
      const durationMs = reduced.current || next.kind === 'pulse' ? PULSE_MS : DOT_MS
      setActive((list) => [...list, { key, effect: next, durationMs }])
      setTimeout(() => {
        if (alive.current) setActive((list) => list.filter((item) => item.key !== key))
      }, durationMs)
    }
    if (queue.current.length > 0)
      timer.current = setTimeout(pump, Math.max(16, queue.current.wait(performance.now())))
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current !== undefined) clearTimeout(timer.current)
    }
  }, [])

  const enqueue = useCallback(
    (effects: Effect[]) => {
      if (effects.length === 0) return
      queue.current.push(effects)
      pump()
    },
    [pump],
  )
  const reset = useCallback(() => {
    queue.current.clear()
    setActive([])
  }, [])
  return { active, enqueue, reset, queue }
}
