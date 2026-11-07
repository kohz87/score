import { useLayoutEffect, useRef, useState } from 'react'
import type { Point } from '../../components/flow-layout/layout.ts'
import { playMotion } from '../../motion/motion.ts'
import type { EffectTone } from './orch-model.ts'
import { toneClass } from './live-diagram-node.ts'

export interface DotRoute {
  points: Point[]
  /** The drawn edge this dot rides on, when there is one; `reverse` when the hand-off goes against its direction. */
  edge: string | null
  reverse: boolean
}

/**
 * A dot rides the real SVG edge path (anime.js motion path), so it follows the routed corners exactly. Without a drawn
 * edge (a straight fallback) it rides a hidden path of the same points. Not rendered at all with reduced motion.
 */
export function Dot({
  route: given,
  durationMs,
  tone,
}: {
  route: DotRoute
  durationMs: number
  tone: EffectTone
}) {
  const ref = useRef<SVGCircleElement>(null)
  // Fixed at mount: a re-render of the diagram must not restart a dot that is already travelling.
  const [route] = useState(given)
  useLayoutEffect(() => {
    const circle = ref.current
    const svgRoot = circle?.ownerSVGElement
    if (!circle || !svgRoot) return
    let temp: SVGPathElement | null = null
    const stop = playMotion(({ animate, svg }) => {
      let path: SVGPathElement | null = route.edge
        ? svgRoot.querySelector<SVGPathElement>(`path[data-edge="${CSS.escape(route.edge)}"]`)
        : null
      if (!path) {
        const ordered = route.reverse ? [...route.points].reverse() : route.points
        temp = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        temp.setAttribute('d', ordered.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '))
        temp.setAttribute('fill', 'none')
        svgRoot.appendChild(temp)
        path = temp
      }
      if (typeof path.getTotalLength !== 'function') return
      const reversed = path === temp ? false : route.reverse
      circle.style.opacity = '1'
      const animation = animate(circle, {
        ...svg.createMotionPath(path),
        rotate: 0,
        duration: durationMs,
        ease: 'inOutQuad',
        reversed,
      })
      return () => {
        animation.cancel()
      }
    })
    return () => {
      stop()
      temp?.remove()
    }
  }, [route, durationMs])
  return (
    <circle
      ref={ref}
      className={`orch-dot ${toneClass(tone)}`}
      r="6"
      cx="0"
      cy="0"
      style={{ opacity: 0 }}
    />
  )
}
