import { useEffect, useRef } from 'react'
import { MOTION, playMotion } from '../../motion/motion.ts'
import { compact } from './context-meter.ts'

/**
 * The token figure of a compaction result: counts down from the size before to the size after. Only a result that
 * arrives while the meter is already on screen (`seen`) counts; one that was there at the start just shows.
 */
export function CountDown({
  from,
  to,
  seen,
}: {
  from: number
  to: number
  seen: React.RefObject<boolean>
}) {
  const text = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!seen.current) return
    const write = (value: number) => {
      if (text.current) text.current.textContent = compact(Math.round(value))
    }
    return playMotion(({ animate }) => {
      const state = { value: from }
      const animation = animate(state, {
        value: to,
        duration: MOTION.slow,
        ease: MOTION.ease,
        onUpdate: () => write(state.value),
        onComplete: () => write(to),
      })
      return () => {
        animation.cancel()
        write(to)
      }
    })
  }, [from, to, seen])
  return <span ref={text}>{compact(to)}</span>
}
