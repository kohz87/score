import { useEffect, useRef, useState } from 'react'
import { useEffectPlayer, usePrefersReducedMotion } from './LiveDiagram.tsx'
import type { Effect } from './orch-model.ts'
import type { Speed } from './ReplayBar.tsx'

type PlaybackEvent = { id: string }

/**
 * Live: dots and highlights play back events that arrive after the page loaded. What was already there is not replayed
 * (that is what Replay is for), and nothing is shown that no event caused. Replay: advance one event after the recorded
 * gap (kept readable), scaled by the speed. Shared by orchestration runs and workflow runs (7.1b).
 */
export function useRunPlayback<E extends PlaybackEvent>({
  id,
  loaded,
  events,
  effectOf,
  delayMs,
}: {
  id: string
  /** The run's data has arrived. */
  loaded: boolean
  events: readonly E[]
  /** What an event shows; both callbacks are read through refs, so a new function each render is fine. */
  effectOf: (event: E) => Effect | null
  /** Milliseconds to wait after event `index` before showing the next at 1x. */
  delayMs: (events: readonly E[], index: number, speed: Speed) => number
}) {
  const reducedMotion = usePrefersReducedMotion()
  const [mode, setMode] = useState<'live' | 'replay'>('live')
  const [count, setCount] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>(1)
  const quiet = reducedMotion || (mode === 'replay' && speed > 1)
  const player = useEffectPlayer(quiet)
  const effect = useRef(effectOf)
  const delay = useRef(delayMs)
  useEffect(() => {
    effect.current = effectOf
    delay.current = delayMs
  })

  const seen = useRef<{ id: string; ids: Set<string> } | null>(null)
  useEffect(() => {
    if (!loaded) return
    if (!seen.current || seen.current.id !== id) {
      seen.current = { id, ids: new Set(events.map((event) => event.id)) }
      return
    }
    const fresh = events.filter((event) => !seen.current!.ids.has(event.id))
    for (const event of fresh) seen.current.ids.add(event.id)
    if (mode !== 'live' || fresh.length === 0) return
    player.enqueue(fresh.flatMap((event) => effect.current(event) ?? []))
  }, [loaded, events, id, mode, player])

  const { enqueue } = player
  useEffect(() => {
    if (mode !== 'replay' || !playing || count >= events.length) return
    const wait = count === 0 ? Math.round(300 / speed) : delay.current(events, count - 1, speed)
    const timer = setTimeout(() => {
      const event = events[count]
      const next = event ? effect.current(event) : null
      if (next) enqueue([next])
      setCount(count + 1)
    }, wait)
    return () => clearTimeout(timer)
  }, [mode, playing, count, speed, events, enqueue])

  return {
    reducedMotion,
    mode,
    replaying: mode === 'replay',
    count,
    playing,
    speed,
    quiet,
    player,
    setCount: (n: number) => {
      player.reset()
      setCount(n)
    },
    setPlaying,
    setSpeed,
    /** Enter or leave the replay; either way it starts from the beginning. */
    toggleReplay: () => {
      player.reset()
      setPlaying(false)
      setCount(0)
      setMode((current) => (current === 'replay' ? 'live' : 'replay'))
    },
  }
}
