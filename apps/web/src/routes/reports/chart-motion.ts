import { useLayoutEffect, type RefObject } from 'react'
import { MOTION, playMotion, prefersReducedMotion } from '../../motion/motion.ts'

// PLAN 5.37: Reports charts draw in once. Elements opt in with data attributes:
//   data-grow   a bar or stack that grows up from its own baseline (CSS: transform-box view-box + origin set inline)
//   data-draw   a line that draws itself (needs pathLength="1")
//   data-fade   a marker, label or total that fades in after the rest
// Web Animations, so a screenshot with animations disabled lands on the final picture.
const drawn = new Set<string>()

/** For tests: forget which charts were drawn. */
export function resetChartDraws() {
  drawn.clear()
}

export function useChartDraw(ref: RefObject<SVGSVGElement | null>, name: string) {
  useLayoutEffect(() => {
    const svg = ref.current
    if (!svg || drawn.has(name) || prefersReducedMotion()) return
    const hide = svg.querySelectorAll<SVGElement>('[data-grow],[data-draw],[data-fade]')
    if (hide.length === 0) return
    // Everything starts hidden so the finished chart does not flash before it draws.
    svg.style.visibility = 'hidden'
    const show = () => svg.style.removeProperty('visibility')
    const safety = window.setTimeout(show, 1500)
    const stop = playMotion(({ waapi }) => {
      drawn.add(name)
      window.clearTimeout(safety)
      const running: Array<{ cancel: () => void }> = []
      try {
        svg.querySelectorAll<SVGElement>('[data-grow]').forEach((element, index) => {
          running.push(
            waapi.animate(element as unknown as HTMLElement, {
              scaleY: [0, 1],
              duration: MOTION.slow,
              delay: Math.min(index * 25, 400),
              ease: 'outCubic',
            }),
          )
        })
        svg.querySelectorAll<SVGElement>('[data-draw]').forEach((element) => {
          running.push(
            waapi.animate(element as unknown as HTMLElement, {
              strokeDasharray: ['1 1', '1 1'],
              strokeDashoffset: [1, 0],
              duration: MOTION.slow + 200,
              delay: 150,
              ease: 'inOutQuad',
            }),
          )
        })
        svg.querySelectorAll<SVGElement>('[data-fade]').forEach((element) => {
          running.push(
            waapi.animate(element as unknown as HTMLElement, {
              opacity: [0, 1],
              duration: MOTION.base,
              delay: MOTION.slow - 100,
              ease: MOTION.ease,
            }),
          )
        })
      } finally {
        show()
      }
      return () => running.forEach((animation) => animation.cancel())
    })
    return () => {
      stop()
      window.clearTimeout(safety)
      show()
    }
  }, [ref, name])
}
