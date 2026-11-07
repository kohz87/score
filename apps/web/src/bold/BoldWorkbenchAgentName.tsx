import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { agentDisplayName } from './bold-agents.ts'

export function AgentName({ agent, id }: { agent: AgentSummary | undefined; id: string }) {
  return (
    <span className="bold-bench-agent" style={agent ? { color: agent.style.color } : undefined}>
      <AgentGlyph
        agent={agent ?? { id, name: id, style: { color: '#626670', shape: 'circle-dot' } }}
        size="xs"
        bare
        decorative
      />
      {agent ? agentDisplayName(agent) : id}
    </span>
  )
}
