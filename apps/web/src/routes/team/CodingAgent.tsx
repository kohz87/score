import type { AgentDetail } from '@score/contract'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { CodingPersonality } from './CodingPersonality.tsx'
import { AgentQuota } from './QuotaMeters.tsx'
import { CodingFacts } from './CodingFacts.tsx'
import { CodingAlerts } from './CodingAlerts.tsx'
import { CodingModelCard } from './CodingModelCard.tsx'
import { CodingAccessCard } from './CodingAccessCard.tsx'
import { CodingDanger } from './CodingDanger.tsx'
import { codingAgentsQuery } from './coding-agent-queries.ts'

export { readsOutsideWorkspace } from './coding-agent-permissions.ts'
export { ReadAccessWarning, PermissionPicker } from './CodingPermission.tsx'
export { useCodingAgentDraft } from './useCodingAgentDraft.ts'

export function CodingOverview({
  agent,
  teamPath = '/team',
  modelFooter,
}: {
  agent: AgentDetail
  /** Where to go after removal; the bold shell passes its own Team route. */
  teamPath?: string
  /** Shown under the Model card (the bold shell's "Set differently in N chats"); nothing for the classic team page. */
  modelFooter?: ReactNode
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
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
    <div className="team-stack">
      {/* Keyed by the agent, not the stored text: a refresh must not unmount an open editor. The editor keeps its
          draft and base etag and shows a change saved elsewhere as the conflict choices. */}
      <CodingPersonality
        key={coding.id}
        coding={coding}
        onChanged={changed}
        facts={<CodingFacts coding={coding} />}
      />
      <CodingAlerts coding={coding} />
      <div className="team-overview-grid">
        <section className="team-card" aria-labelledby="coding-limits" data-protected="block">
          <h2 id="coding-limits">Limits left</h2>
          <AgentQuota
            agentId={coding.id}
            runtime={coding.runtime}
            floor={coding.quotaFloorPercent}
          />
        </section>
        <CodingModelCard
          key={`model:${coding.model ?? ''}:${coding.effort ?? ''}:${coding.advisorModel ?? ''}`}
          coding={coding}
          onChanged={changed}
        />
        {modelFooter}
        <CodingAccessCard
          key={`access:${coding.permission}:${coding.quotaFloorPercent}`}
          coding={coding}
          onChanged={changed}
        />
      </div>
      <CodingDanger
        coding={coding}
        onRemoved={() => {
          changed()
          void navigate(teamPath)
        }}
      />
    </div>
  )
}
