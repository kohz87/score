import { useLayoutEffect, useRef, type HTMLAttributes } from 'react'
import { MOTION, markMotionBusy, playMotion, prefersReducedMotion } from './motion.ts'

// A card that needs the person arrives once: it fades in with an 8 px rise and gives one soft attention pulse. Never
// looping, and never again for the same card in this tab (a re-render, or coming back to the page, shows it as is).
const arrived = new Set<string>()

const PULSE_FROM = '0 0 0 0 rgba(18, 19, 26, 0.3)'
const PULSE_TO = '0 0 0 10px rgba(18, 19, 26, 0)'

/** For tests: forget which cards have arrived. */
export function resetArrivals() {
  arrived.clear()
}

export function useArrival(ref: React.RefObject<HTMLElement | null>, arrivalId: string | null) {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || arrivalId === null || arrived.has(arrivalId) || prefersReducedMotion()) return
    // Hidden until the animation owns the opacity, so the card does not flash in full before it fades in.
    element.style.opacity = '0'
    const settled = markMotionBusy()
    const reveal = () => {
      element.style.removeProperty('opacity')
      settled()
    }
    const safety = window.setTimeout(reveal, 1500)
    const stop = playMotion(({ waapi }) => {
      arrived.add(arrivalId)
      window.clearTimeout(safety)
      try {
        const entrance = waapi.animate(element, {
          opacity: [0, 1],
          translateY: [8, 0],
          duration: MOTION.base,
          ease: MOTION.ease,
        })
        reveal()
        const pulse = waapi.animate(element, {
          boxShadow: [PULSE_FROM, PULSE_TO],
          duration: MOTION.slow + 200,
          delay: MOTION.base - 100,
          ease: 'outQuad',
        })
        return () => {
          entrance.cancel()
          pulse.cancel()
        }
      } catch (failure) {
        reveal()
        throw failure
      }
    })
    return () => {
      stop()
      window.clearTimeout(safety)
      reveal()
    }
  }, [ref, arrivalId])
}

type ArrivalProps = HTMLAttributes<HTMLElement> & { arrivalId: string | null }

/** A `<section>` that arrives with `useArrival`. */
export function Arrival({ arrivalId, ...props }: ArrivalProps) {
  const ref = useRef<HTMLElement>(null)
  useArrival(ref, arrivalId)
  return <section ref={ref} {...props} />
}
