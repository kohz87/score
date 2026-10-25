import type { AgentDetail } from '@score/contract'
import { agentDisplayName } from '../bold-agents.ts'
import { MoreCard } from './MoreCard.tsx'

/** The same panel as "Remove agent…" in the header: this only opens it. */
export function DeleteCard({ agent, onDelete }: { agent: AgentDetail; onDelete: () => void }) {
  return (
    <MoreCard id="agent-delete" title={`Delete ${agentDisplayName(agent)}`} danger>
      <span className="small muted">
        Removes the agent from the team. A private export is kept first.
      </span>
      <button type="button" className="btn sm danger" onClick={onDelete}>
        Delete agent
      </button>
    </MoreCard>
  )
}
