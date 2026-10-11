import { useEffect, useLayoutEffect, useRef } from 'react'
import { MOTION, markMotionBusy, playMotion, prefersReducedMotion } from './motion.ts'

/**
 * Tweens a number to a new target and reports every step to `apply` (which writes the DOM directly, so a stream of
 * frames does not re-render React). The first render, an unchanged target, reduced motion and `enabled: false` do not
 * animate: React has already rendered the final value. `initial` makes the first render count up from that value.
 * A tween that is interrupted or unmounted lands on its target, and so does one whose animation never starts.
 */
export function useValueTween(
  target: number | null,
  apply: (value: number) => void,
  {
    enabled = true,
    duration = MOTION.slow,
    initial,
  }: { enabled?: boolean; duration?: number; initial?: number } = {},
) {
  const shown = useRef(initial ?? target)
  const write = useRef(apply)
  useEffect(() => {
    write.current = apply
  })
  useLayoutEffect(() => {
    const from = shown.current
    shown.current = target
    if (target === null || from === null || from === target || !enabled) return
    if (prefersReducedMotion()) return
    const release = markMotionBusy()
    // Back to where it was until the animation takes over, so the final figure does not flash first.
    write.current(from)
    const state = { value: from }
    let animation: { cancel: () => void } | undefined
    const land = () => {
      write.current(target)
      release()
    }
    const safety = window.setTimeout(land, duration + 2000)
    const stop = playMotion(({ animate }) => {
      try {
        animation = animate(state, {
          value: target,
          duration,
          ease: MOTION.ease,
          onUpdate: () => write.current(state.value),
          onComplete: () => {
            window.clearTimeout(safety)
            land()
          },
        })
      } catch (failure) {
        land()
        throw failure
      }
    })
    return () => {
      stop()
      animation?.cancel()
      window.clearTimeout(safety)
      land()
    }
  }, [target, enabled, duration])
}
