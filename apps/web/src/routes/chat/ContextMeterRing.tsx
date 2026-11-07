import { useRef } from 'react'
import { useValueTween } from '../../motion/use-value-tween.ts'
import { compact } from './context-meter.ts'

const RADIUS = 11
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** Level of the ring: colour steps are redundant with the percentage in its name. */
export function ringLevel(fraction: number | null): 'normal' | 'warn' | 'high' {
  if (fraction === null) return 'normal'
  return fraction >= 0.9 ? 'high' : fraction >= 0.75 ? 'warn' : 'normal'
}

export const percent = (fraction: number) => Math.min(100, Math.round(fraction * 100))

/** The ring and its figure. A new reading moves the stroke and counts the percentage to it (PLAN 5.37). */
export function RingFace({ fraction, used }: { fraction: number | null; used: number | null }) {
  const fill = useRef<SVGCircleElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  useValueTween(fraction, (value) => {
    fill.current?.setAttribute('stroke-dasharray', `${CIRCUMFERENCE * value} ${CIRCUMFERENCE}`)
    if (text.current) text.current.textContent = `${percent(value)}%`
  })
  return (
    <>
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <circle className="chat-ctx-track" cx="14" cy="14" r={RADIUS} />
        {fraction !== null && (
          <circle
            ref={fill}
            className="chat-ctx-fill"
            cx="14"
            cy="14"
            r={RADIUS}
            strokeDasharray={`${CIRCUMFERENCE * fraction} ${CIRCUMFERENCE}`}
            transform="rotate(-90 14 14)"
          />
        )}
      </svg>
      <span ref={text} className="chat-ctx-text">
        {fraction !== null ? `${percent(fraction)}%` : compact(used ?? 0)}
      </span>
    </>
  )
}
