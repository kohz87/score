import { clock, type Chip } from './resolved.ts'
import './live.css'

/** "✓ Approved by you · 14:02" / "✗ Rejected · 14:03": the mark is a shape, so the tone is never colour alone. */
export function ResolvedChip({ chip, className = '' }: { chip: Chip; className?: string }) {
  return (
    <span className={`live-chip live-chip--${chip.tone}${className ? ` ${className}` : ''}`}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        {chip.tone === 'ok' ? (
          <path d="M2 6.5 L5 9.5 L10 3" fill="none" stroke="currentColor" strokeWidth="2" />
        ) : chip.tone === 'no' ? (
          <path d="M3 3 L9 9 M9 3 L3 9" fill="none" stroke="currentColor" strokeWidth="2" />
        ) : (
          <path d="M2 6 H10" fill="none" stroke="currentColor" strokeWidth="2" />
        )}
      </svg>
      <span>{chip.text}</span>
      {chip.at && (
        <>
          <span aria-hidden="true">·</span>
          <time dateTime={chip.at}>{clock(chip.at)}</time>
        </>
      )}
    </span>
  )
}
