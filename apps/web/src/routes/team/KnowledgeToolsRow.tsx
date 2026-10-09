import type { AgentDetail } from '@score/contract'
import { useKnowledgeAccess, useSetKnowledgeAccess } from './knowledge-access-queries.ts'
import { tabFailure } from './tab-errors.ts'

// The per-agent switch for the knowledge tools (contract §12). The global switch is in Settings › Knowledge.
export function KnowledgeToolsRow({ agent }: { agent: AgentDetail }) {
  const access = useKnowledgeAccess(agent.id)
  const change = useSetKnowledgeAccess(agent.id)
  if (access.isError) return null
  return (
    <li>
      <span>
        Knowledge tools<small> search, read and write the shared vault of notes</small>
        {change.isError && <em role="alert">{tabFailure(change.error, 'change this setting')}</em>}
      </span>
      <button
        type="button"
        role="switch"
        className="team-toggle"
        data-enabled={access.data?.enabled ?? false}
        aria-checked={access.data?.enabled ?? false}
        aria-label={`Knowledge tools enabled for ${agent.name}`}
        disabled={!access.data || change.isPending}
        onClick={() => change.mutate(!access.data?.enabled)}
      />
    </li>
  )
}
