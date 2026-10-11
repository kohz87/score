import { useRef } from 'react'
import { useValueTween } from '../../motion/use-value-tween.ts'

// A headline figure that counts up from zero on load (and to the new figure when the range changes). Figures that are
// not a plain number with a prefix and a suffix ("—", "1,234") just show. The text is the final text from the start.
const PLAIN_NUMBER = /^(\D*)(\d+(?:\.\d+)?)(\D*)$/

export function CountUp({ text, className }: { text: string; className?: string }) {
  const element = useRef<HTMLSpanElement>(null)
  const match = PLAIN_NUMBER.exec(text)
  const target = match ? Number(match[2]) : null
  const decimals = match?.[2]?.split('.')[1]?.length ?? 0
  useValueTween(
    target,
    (value) => {
      if (element.current && match)
        element.current.textContent = `${match[1]}${value.toFixed(decimals)}${match[3]}`
    },
    { initial: 0 },
  )
  return (
    <span ref={element} className={className}>
      {text}
    </span>
  )
}
