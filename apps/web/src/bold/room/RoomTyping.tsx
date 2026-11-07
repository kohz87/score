import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentDisplayName } from '../bold-agents.ts'

export function RoomTyping({
  agents,
  typing,
}: {
  agents: AgentSummary[]
  typing: Record<string, string>
}) {
  return (
    <>
      {Object.entries(typing).map(([agentId, text]) => {
        const agent = agents.find((item) => item.id === agentId)
        if (!agent) return null
        return (
          <p className="bold-typing" key={agentId} role="status">
            <AgentGlyph
              agent={agent}
              size="xs"
              bare
              decorative
              mood={text ? 'working' : 'thinking'}
            />{' '}
            <b>{agentDisplayName(agent)}</b> {text}
          </p>
        )
      })}
    </>
  )
}
