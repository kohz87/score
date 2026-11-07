import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../components/AgentGlyph.tsx'

export function Chips<T extends string>({
  label,
  options,
  value,
  onPick,
  className,
}: {
  label: string
  options: { id: T | null; label: string; agent?: AgentSummary }[]
  value: T | null
  onPick: (id: T | null) => void
  className?: string
}) {
  return (
    <div
      className={`bold-tb-chips${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.id ?? 'all'}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onPick(option.id)}
        >
          {option.agent && <AgentGlyph agent={option.agent} size="xs" bare decorative />}
          {option.label}
        </button>
      ))}
    </div>
  )
}
