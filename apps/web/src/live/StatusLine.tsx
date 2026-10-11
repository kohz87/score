import { statusSegments } from './status-line.ts'
import './live.css'

/**
 * The status line of a working agent: one short line, tool names in code style. It reserves its height, so a line
 * appearing or changing never moves what is around it (`reserve`). `live` makes a screen reader announce changes.
 */
export function StatusLine({
  line,
  live = false,
  reserve = true,
  className = '',
}: {
  line: string | null
  live?: boolean
  reserve?: boolean
  className?: string
}) {
  if (line === null && !reserve) return null
  return (
    <p
      className={`live-status${line === null ? ' live-status--idle' : ''}${className ? ` ${className}` : ''}`}
      {...(live ? { role: 'status', 'aria-live': 'polite' as const } : {})}
      data-status-line={line ?? undefined}
    >
      {line !== null &&
        statusSegments(line).map((segment, index) =>
          index % 2 === 1 ? <code key={index}>{segment}</code> : segment,
        )}
    </p>
  )
}
