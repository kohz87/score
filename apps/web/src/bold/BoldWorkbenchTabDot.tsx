import type { AgentSummary } from '@score/contract'

export function TabDot({ agent }: { agent: AgentSummary | undefined }) {
  return (
    <span
      className="bold-bench-dot"
      aria-hidden="true"
      style={{ background: agent?.style.color ?? 'var(--muted)' }}
    />
  )
}
