import type { AgentDetail } from '@score/contract'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SubagentsCard } from '../agent-more/SubagentsCard.tsx'
import { EffortChatsCard } from '../efforts/EffortChatsCard.tsx'
import { codingAgentsQuery } from '../../routes/team/coding-agent-queries.ts'
import { CodingAccessCard } from '../../routes/team/CodingAccessCard.tsx'
import { CodingAlerts } from '../../routes/team/CodingAlerts.tsx'
import { CodingFacts } from '../../routes/team/CodingFacts.tsx'
import { CodingModelCard } from '../../routes/team/CodingModelCard.tsx'
import { CodingPersonality } from '../../routes/team/CodingPersonality.tsx'
import { AgentQuota } from '../../routes/team/QuotaMeters.tsx'
import { ToolsSection } from './ToolsSection.tsx'
import { WorkSection } from './WorkSection.tsx'

/**
 * A coding agent's sections: the same menu as a Hermes agent's, leaving out what doesn't apply (no memory or skills,
 * no plugins or channels, no repeating jobs). Removing it goes through the page's one Remove flow.
 */
export function CodingSections({
  agent,
  files,
  onCloseFiles,
}: {
  agent: AgentDetail
  files: { path: string | null } | null
  onCloseFiles: () => void
}) {
  const queryClient = useQueryClient()
  const list = useQuery(codingAgentsQuery)
  const coding = list.data?.find((item) => item.id === agent.id)
  if (list.isPending) return <p role="status">Loading…</p>
  if (!coding)
    return (
      <section className="team-card" role="alert">
        <p>This coding agent is no longer available.</p>
      </section>
    )
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: ['coding'] })
    void queryClient.invalidateQueries({ queryKey: ['team'] })
  }
  return (
    <div className="bold-coding">
      <div id="agent-personality" className="bold-agent-section">
        {/* Keyed by the agent, not the stored text: a refresh must not unmount an open editor. */}
        <CodingPersonality
          key={coding.id}
          coding={coding}
          onChanged={changed}
          facts={<CodingFacts coding={coding} />}
        />
        <CodingAlerts coding={coding} />
      </div>
      <div id="agent-model" className="bold-agent-section">
        <CodingModelCard
          key={`model:${coding.model ?? ''}:${coding.effort ?? ''}:${coding.advisorModel ?? ''}`}
          coding={coding}
          onChanged={changed}
        />
        <EffortChatsCard agentId={agent.id} />
        <SubagentsCard agent={agent} />
      </div>
      <section className="bold-agent-section" id="agent-safety" aria-label="Safety">
        <div className="bold-agent-tiles">
          <section className="team-card" aria-labelledby="coding-limits" data-protected="block">
            <h2 id="coding-limits">Limits left</h2>
            <AgentQuota
              agentId={coding.id}
              runtime={coding.runtime}
              floor={coding.quotaFloorPercent}
            />
          </section>
          <CodingAccessCard
            key={`access:${coding.permission}:${coding.quotaFloorPercent}`}
            coding={coding}
            onChanged={changed}
          />
        </div>
      </section>
      <ToolsSection agent={agent} coding />
      <WorkSection agent={agent} coding files={files} onCloseFiles={onCloseFiles} />
    </div>
  )
}
