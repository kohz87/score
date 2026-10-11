import { useEffect, useRef } from 'react'
import { MOTION, playMotion } from './motion.ts'

/**
 * Tweens a number to a new target and reports every step to `apply` (which writes the DOM directly, so a stream of
 * frames does not re-render React). The first render, an unchanged target, reduced motion and `enabled: false` do not
 * animate: React has already rendered the final value. A tween that is interrupted or unmounted lands on its target.
 */
export function useValueTween(
  target: number | null,
  apply: (value: number) => void,
  { enabled = true, duration = MOTION.slow }: { enabled?: boolean; duration?: number } = {},
) {
  const shown = useRef(target)
  const write = useRef(apply)
  useEffect(() => {
    write.current = apply
  })
  useEffect(() => {
    const from = shown.current
    shown.current = target
    if (target === null || from === null || from === target || !enabled) return
    const state = { value: from }
    let animation: { cancel: () => void } | undefined
    const stop = playMotion(({ animate }) => {
      animation = animate(state, {
        value: target,
        duration,
        ease: MOTION.ease,
        onUpdate: () => write.current(state.value),
        onComplete: () => write.current(target),
      })
    })
    return () => {
      stop()
      animation?.cancel()
      write.current(target)
    }
  }, [target, enabled, duration])
}
