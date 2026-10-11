import { useRef } from 'react'
import { useValueTween } from '../motion/use-value-tween.ts'

/**
 * A figure of a running run that ticks up when it changes (PLAN 5.39). The first render and reduced motion just show
 * the number. The text is always the final text, so a screen reader never reads a half-counted figure.
 */
export function LiveCount({
  value,
  format = (n) => Math.round(n).toLocaleString(),
  className,
}: {
  value: number
  format?: (value: number) => string
  className?: string
}) {
  const element = useRef<HTMLSpanElement>(null)
  useValueTween(value, (shown) => {
    if (element.current) element.current.textContent = format(shown)
  })
  return (
    <span ref={element} className={className} data-live-count={value}>
      {format(value)}
    </span>
  )
}
