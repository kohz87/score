import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentDisplayName } from '../bold-agents.ts'
import { Starters } from './direct-parts.tsx'

export function Welcome({
  agent,
  title,
  onAsk,
  busy = false,
}: {
  agent: AgentSummary
  title?: string
  onAsk: (text: string) => void
  busy?: boolean
}) {
  return (
    <div className="bold-dm-welcome">
      <AgentGlyph agent={agent} size="lg" decorative />
      <h2>{title ?? `Just you and ${agentDisplayName(agent)}`}</h2>
      <p className="muted">
        Nothing here reaches the team room unless you share it. {agentDisplayName(agent)} keeps
        working on its jobs while you talk.
      </p>
      <Starters onAsk={onAsk} disabled={busy} />
    </div>
  )
}
