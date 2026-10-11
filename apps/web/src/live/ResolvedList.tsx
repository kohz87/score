import { ResolvedChip } from './ResolvedChip.tsx'
import type { Resolved } from './use-recently-resolved.ts'
import './live.css'

/** The chips of cards that were just decided, where the cards were. */
export function ResolvedList({ items }: { items: readonly Resolved[] }) {
  if (items.length === 0) return null
  return (
    <ul className="live-resolved" aria-label="Just decided">
      {items.map((item) => (
        <li key={item.id}>
          <ResolvedChip chip={item.chip} />
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  )
}
