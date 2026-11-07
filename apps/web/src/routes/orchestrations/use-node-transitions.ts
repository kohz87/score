import { useEffect, useRef } from 'react'
import { MOTION, playMotion } from '../../motion/motion.ts'
import type { NodeVisual } from './orch-model.ts'

const CHECK_PATH = 'M4 11 L9 16 L18 5'

/**
 * Node state changes (queued → running → done / failed): a short settle of the node, a ring that flows out of it and,
 * for done, a check that draws itself. Several nodes changing at once start in a short stagger. The first render, and
 * nodes that merely appear, do not animate; neither does a quiet diagram (reduced motion, fast replay).
 */
export function useNodeTransitions(
  root: React.RefObject<HTMLDivElement | null>,
  visuals: ReadonlyMap<string, NodeVisual>,
  quiet: boolean,
) {
  const previous = useRef<Map<string, NodeVisual> | null>(null)
  const running = useRef(new Set<() => void>())
  useEffect(() => {
    const before = previous.current
    previous.current = new Map(visuals)
    if (!before || quiet || !root.current) return
    const changed: Array<{ id: string; to: NodeVisual }> = []
    for (const [id, to] of visuals) {
      const was = before.get(id)
      if (was !== undefined && was !== to) changed.push({ id, to })
    }
    if (changed.length === 0) return
    const container = root.current
    const stop = playMotion(({ animate, svg }) => {
      const cleanups: Array<() => void> = []
      const nodes = changed.flatMap(({ id, to }) => {
        const node = container.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)
        return node ? [{ node, to }] : []
      })
      nodes.forEach(({ node, to }, index) => {
        const start = index * MOTION.stagger
        const ring = document.createElement('span')
        ring.className = 'orch-node__ring'
        ring.setAttribute('aria-hidden', 'true')
        node.appendChild(ring)
        const settle = animate(node, {
          scale: [
            { to: 1.045, duration: 160 },
            { to: 1, duration: 300 },
          ],
          delay: start,
          ease: MOTION.ease,
          onComplete: () => node.style.removeProperty('transform'),
        })
        const flow = animate(ring, {
          opacity: [0.45, 0],
          scale: [1, 1.12],
          duration: MOTION.slow,
          delay: start,
          ease: MOTION.ease,
          onComplete: () => ring.remove(),
        })
        cleanups.push(() => {
          settle.cancel()
          flow.cancel()
          node.style.removeProperty('transform')
          ring.remove()
        })
        if (to === 'succeeded') {
          const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          mark.setAttribute('class', 'orch-node__check')
          mark.setAttribute('viewBox', '0 0 22 22')
          mark.setAttribute('aria-hidden', 'true')
          const tick = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          tick.setAttribute('d', CHECK_PATH)
          mark.appendChild(tick)
          node.appendChild(mark)
          const [drawable] = svg.createDrawable(tick)
          const draw = animate(drawable!, {
            draw: ['0 0', '0 1'],
            duration: MOTION.base,
            delay: start + 120,
            ease: MOTION.ease,
          })
          const fade = animate(mark, {
            opacity: [1, 0],
            duration: MOTION.fast,
            delay: start + 120 + MOTION.base + 500,
            ease: 'linear',
            onComplete: () => mark.remove(),
          })
          cleanups.push(() => {
            draw.cancel()
            fade.cancel()
            mark.remove()
          })
        }
      })
      const all = () => cleanups.forEach((fn) => fn())
      running.current.add(all)
      window.setTimeout(() => running.current.delete(all), 3000)
    })
    running.current.add(stop)
  }, [visuals, quiet, root])
  useEffect(() => {
    const live = running.current
    return () => {
      live.forEach((fn) => fn())
      live.clear()
    }
  }, [])
}
