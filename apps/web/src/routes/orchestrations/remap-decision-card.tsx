import type { AgentSummary, NeedsYou, OrchestrationDetail } from '@score/contract'
import { Arrival } from '../../motion/Arrival.tsx'
import { AgentChip, ErrorLine } from './decision-parts.tsx'
import type { RunActions } from './orchestration-queries.ts'

/** An agent was replaced after the run started: use the new one for the rest of the run, or Stop the run. */
export function RemapCard({
  run,
  item,
  agents,
  actions,
}: {
  run: OrchestrationDetail
  item: Extract<NeedsYou, { kind: 'remap' }>
  agents: AgentSummary[]
  actions: RunActions
}) {
  const gone = item.currentIncarnation === 'untracked'
  return (
    <Arrival
      arrivalId={`remap-${item.agentId}`}
      data-protected="block"
      className="orch-decision"
      aria-label={`Replaced ${item.agentId}`}
    >
      <h3>
        <AgentChip agentId={item.agentId} agents={agents} /> was replaced
        <small>{item.role === 'lead' ? ' The lead of this run' : ' An agent of this run'}</small>
      </h3>
      <p>
        {gone
          ? 'This agent no longer exists, so the run can’t use it. You can stop the run.'
          : `This run was started with the earlier ${item.agentId}. Nothing is assigned to the new one until you decide. Steps already given to the earlier one stay blocked, and the lead assigns them again.`}
      </p>
      <div className="orch-actions">
        {!gone && (
          <button
            type="button"
            disabled={actions.remap.isPending}
            onClick={() =>
              actions.remap.mutate({
                agentId: item.agentId,
                frozenIncarnation: item.frozenIncarnation,
                currentIncarnation: item.currentIncarnation,
                orchestrationRevision: run.revision,
                acknowledge: true,
              })
            }
          >
            Use the new {item.agentId} for this run
          </button>
        )}
      </div>
      <ErrorLine error={actions.remap.error} />
    </Arrival>
  )
}
