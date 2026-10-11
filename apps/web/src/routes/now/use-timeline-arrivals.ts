import { useEffect, useRef, type RefObject } from 'react'
import { MOTION, playMotion } from '../../motion/motion.ts'

// PLAN 5.37: what is new on the Score timeline arrives with motion: a block grows in from its start, and a hand-off
// connector draws itself from the giver to the receiver once its blocks are there. What was on screen already, and what
// merely moved because the window or the plot width changed, does not animate.

type Link = { id: string; kind: string }

export function useTimelineArrivals(
  plot: RefObject<HTMLElement | null>,
  blockIds: readonly string[],
  links: readonly Link[],
  plotWidth: number,
) {
  const before = useRef<{ blocks: Set<string>; links: Set<string>; width: number } | null>(null)
  const running = useRef(new Set<() => void>())
  useEffect(() => {
    const previous = before.current
    before.current = {
      blocks: new Set(blockIds),
      links: new Set(links.map((l) => l.id)),
      width: plotWidth,
    }
    const root = plot.current
    // A width change regroups blocks (new ids for the same work): that is layout, not news.
    if (!previous || !root || previous.width !== plotWidth) return
    const newBlocks = blockIds.filter((id) => !previous.blocks.has(id))
    const newLinks = links.filter((link) => !previous.links.has(link.id))
    if (newBlocks.length === 0 && newLinks.length === 0) return
    const find = (attribute: string, id: string) =>
      root.querySelector<SVGElement | HTMLElement>(`[${attribute}="${CSS.escape(id)}"]`)
    const stop = playMotion(({ animate, waapi, svg }) => {
      const cleanups: Array<() => void> = []
      newBlocks.forEach((id, index) => {
        const element = find('data-arrive-block', id)
        if (!element) return
        element.style.transformOrigin = '0 50%'
        const grow = waapi.animate(element as HTMLElement, {
          opacity: [0, 1],
          scaleX: [0.15, 1],
          duration: MOTION.base,
          delay: index * MOTION.stagger,
          ease: MOTION.ease,
          onComplete: () => element.style.removeProperty('transform-origin'),
        })
        cleanups.push(() => {
          grow.cancel()
          element.style.removeProperty('transform-origin')
        })
      })
      const delay = newBlocks.length > 0 ? MOTION.base - 150 : 0
      newLinks.forEach((link, index) => {
        const path = find('data-arrive-link', link.id)
        if (!path) return
        // The label arrives with the end of the stroke.
        const label = find('data-arrive-label', link.id)
        if (label) {
          const appear = waapi.animate(label as HTMLElement, {
            opacity: [0, 1],
            duration: MOTION.fast,
            delay: delay + index * MOTION.stagger + MOTION.slow - 150,
            ease: MOTION.ease,
          })
          cleanups.push(() => appear.cancel())
        }
        // A dashed connector cannot be drawn with a dash trick (the dashes are its look): it fades in instead.
        if (link.kind === 'sent_back') {
          const fade = waapi.animate(path as unknown as HTMLElement, {
            opacity: [0, 1],
            duration: MOTION.base,
            delay,
            ease: MOTION.ease,
          })
          cleanups.push(() => fade.cancel())
          return
        }
        const [drawable] = svg.createDrawable(path as SVGGeometryElement)
        if (!drawable) return
        const draw = animate(drawable, {
          draw: ['0 0', '0 1'],
          duration: MOTION.slow,
          delay: delay + index * MOTION.stagger,
          ease: 'inOutQuad',
          onComplete: () => {
            path.removeAttribute('stroke-dasharray')
            path.removeAttribute('stroke-dashoffset')
          },
        })
        cleanups.push(() => {
          draw.cancel()
          path.removeAttribute('stroke-dasharray')
          path.removeAttribute('stroke-dashoffset')
        })
      })
      return () => cleanups.forEach((fn) => fn())
    })
    running.current.add(stop)
  }, [plot, blockIds, links, plotWidth])
  useEffect(() => {
    const live = running.current
    return () => {
      live.forEach((fn) => fn())
      live.clear()
    }
  }, [])
}
