import type { AgentDetail } from '@score/contract'
import { AgentStylePicker } from '../../routes/team/AgentStylePicker.tsx'
import { MoreCard } from './MoreCard.tsx'

/** Colour and shape. The picker is Score's existing one (it saves through the same PATCH). */
export function LooksCard({ agent }: { agent: AgentDetail }) {
  return (
    <MoreCard id="agent-appearance" title="Looks">
      <span className="small muted">Change {agent.name}’s colour and shape.</span>
      <AgentStylePicker key={agent.id} agent={agent} />
    </MoreCard>
  )
}
