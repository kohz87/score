import { Arrival } from '../../motion/Arrival.tsx'
import { gateChip } from '../../live/resolved.ts'
import { ResolvedList } from '../../live/ResolvedList.tsx'
import { useRecentlyResolved } from '../../live/use-recently-resolved.ts'
import type { AgentSummary, OrchestrationDetail } from '@score/contract'
import { useCallback } from 'react'
import { orchCoding, needsYouText } from './orch-model.ts'
import { fetchPreflight, type RunActions } from './orchestration-queries.ts'
import {
  CodingLimitCard,
  PolicyChangedCard,
  QuotaLowCard,
  type PreflightWorker,
} from './CodingCards.tsx'
import { CancelFenceCard, UnknownCard } from './fence-decision-cards.tsx'
import { GateCard, InquiryCard } from './gate-decision-cards.tsx'
import { LimitsCard } from './limit-decision-card.tsx'
import { RemapCard } from './remap-decision-card.tsx'

// The decisions a run asks of the person, each bound to the revision the page showed (contract §14). A stale page
// is answered with `409 conflict`: the run is read again and the person decides again.

export { AgentChip, CliBadge, ErrorLine, sourceName } from './decision-parts.tsx'

export type { GateRun, LimitsRun, AttemptsRun } from './run-decision-types.ts'
export { CancelFenceCard, UnknownCard }
export { GateCard, InquiryCard }
export { LimitsCard }
export { RemapCard }

/** Every item the run needs from the person, typed as the server lists them (`needsYou[]`). */
export function RunNeeds({
  run,
  agents,
  actions,
}: {
  run: OrchestrationDetail
  agents: AgentSummary[]
  actions: RunActions
}) {
  // The run's own check of a coding agent: its preflight with this lead and that one agent.
  const leadAgentId = run.leadAgentId
  const preflightWorker = useCallback<PreflightWorker>(
    async (agentId) =>
      (await fetchPreflight(leadAgentId, [agentId])).workers.find(
        (entry) => entry.agentId === agentId,
      ),
    [leadAgentId],
  )
  const coding = orchCoding(run.coding, run.quotaFloorPercent)
  const openGates = new Set(
    run.needsYou.flatMap((item) => (item.kind === 'gate' ? [item.gateId] : [])),
  )
  // A decided gate stays where it was, as a chip, for a moment.
  const decided = useRecentlyResolved(openGates, (id) => {
    const gate = run.gates.find((item) => item.id === id)
    const chip = gate ? gateChip(gate) : null
    return gate && chip ? { label: gate.stepId, chip } : null
  })
  if (run.needsYou.length === 0 && decided.length === 0) return null
  // A cancelled step whose attempt is also not confirmed ended is one card with both actions.
  const unknownIds = new Set(
    run.needsYou.flatMap((item) => (item.kind === 'unknown' ? [item.attemptId] : [])),
  )
  const fenceFor = (attemptId: string): { fenceStepId?: string } => {
    const fence = run.needsYou.find(
      (item) => item.kind === 'cancel_fence' && item.attemptId === attemptId,
    )
    return fence?.kind === 'cancel_fence' ? { fenceStepId: fence.stepId } : {}
  }
  return (
    <div className="orch-needs" aria-label="Needs you" data-protected="grid">
      <ResolvedList items={decided} />
      {run.needsYou.map((item) => {
        switch (item.kind) {
          case 'gate':
            return (
              <GateCard
                key={`g${item.gateId}`}
                run={run}
                gateId={item.gateId}
                agents={agents}
                actions={actions}
              />
            )
          case 'inquiry':
            return (
              <InquiryCard
                key={`q${item.inquiryId}`}
                run={run}
                inquiryId={item.inquiryId}
                actions={actions}
              />
            )
          case 'budget':
            return (
              <LimitsCard
                key={`b${item.reason}`}
                run={run}
                coding={coding}
                reason={item.reason}
                actions={actions}
              />
            )
          case 'unknown':
            return (
              <UnknownCard
                key={`u${item.attemptId}`}
                run={run}
                attemptId={item.attemptId}
                actions={actions}
                {...fenceFor(item.attemptId)}
              />
            )
          case 'cancel_fence':
            if (unknownIds.has(item.attemptId)) return null
            return (
              <CancelFenceCard
                key={`c${item.attemptId}`}
                run={run}
                stepId={item.stepId}
                actions={actions}
              />
            )
          case 'remap':
            return (
              <RemapCard
                key={`m${item.agentId}`}
                run={run}
                item={item}
                agents={agents}
                actions={actions}
              />
            )
          case 'policy_changed':
            return (
              <PolicyChangedCard
                key={`pc${item.stepId}`}
                scope={run.id}
                arrivalKey={item.stepId}
                what={item.stepId}
                agentId={item.agentId}
                agents={agents}
                preflightWorker={preflightWorker}
                pending={actions.policyRemap.isPending}
                error={actions.policyRemap.error}
                onUse={(decision) =>
                  actions.policyRemap.mutate({
                    stepId: item.stepId,
                    body: {
                      agentId: item.agentId,
                      ...decision,
                      orchestrationRevision: run.revision,
                    },
                  })
                }
              />
            )
          case 'quota_low':
            return (
              <QuotaLowCard
                key={`ql${item.stepId}`}
                arrivalKey={item.stepId}
                what={item.stepId}
                hold={item}
                agents={agents}
                pending={actions.quota.isPending}
                error={actions.quota.error}
                onAnswer={(answer) =>
                  actions.quota.mutate({
                    stepId: item.stepId,
                    body: { answer, orchestrationRevision: run.revision },
                  })
                }
              />
            )
          case 'coding_limit':
            return (
              <CodingLimitCard
                key={`cl${item.stepId}`}
                arrivalKey={item.stepId}
                waiting={item.stepId}
                coding={coding ?? { codingSteps: 0 }}
                pending={actions.limits.isPending}
                error={actions.limits.error}
                onRaise={(codingSteps) =>
                  actions.limits.mutate({ orchestrationRevision: run.revision, codingSteps })
                }
              />
            )
          case 'paused':
            return (
              <Arrival
                arrivalId={`paused-${item.reason}`}
                key={`p${item.reason}`}
                data-protected="block"
                className="orch-decision"
                aria-label="Paused"
              >
                <h3>{needsYouText(item)}</h3>
              </Arrival>
            )
          case 'fence':
            return (
              <Arrival
                arrivalId={'fence'}
                key="fence"
                data-protected="block"
                className="orch-decision"
                aria-label="Blocked"
              >
                <h3>{needsYouText(item)}</h3>
                <p>Review the list on Now to lift the block.</p>
              </Arrival>
            )
        }
      })}
    </div>
  )
}
