import type { AgentSummary, Job, OrchestrationDetail } from '@score/contract'
import { useCallback } from 'react'
import { Arrival } from '../../motion/Arrival.tsx'
import { needsYouText, orchCoding } from '../../routes/orchestrations/orch-model.ts'
import {
  fetchPreflight,
  useRun,
  useRunActions,
  type RunActions,
} from '../../routes/orchestrations/orchestration-queries.ts'
import {
  CancelFenceCard,
  GateCard,
  InquiryCard,
  LimitsCard,
  RemapCard,
  UnknownCard,
} from '../../routes/orchestrations/RunDecisions.tsx'
import {
  CodingLimitCard,
  PolicyChangedCard,
  QuotaLowCard,
  type PreflightWorker,
} from '../../routes/orchestrations/CodingCards.tsx'
import { pinLabel, pinNotice, RunPin } from './RunSafetyPins.tsx'
import { orchestrationNeedEntries, type OrchestrationNeedEntry } from './run-safety-entries.ts'

export function OrchestrationRunRequests({ job, agents }: { job: Job; agents: AgentSummary[] }) {
  const runId = job.recipe?.ref ?? ''
  const run = useRun(runId)
  const actions = useRunActions(runId)
  const detail = run.data?.snapshot.orchestration
  const entries = detail ? orchestrationNeedEntries(detail) : []
  const leadAgentId = detail?.leadAgentId ?? ''
  const preflightWorker = useCallback<PreflightWorker>(
    async (agentId) =>
      (await fetchPreflight(leadAgentId, [agentId])).workers.find(
        (entry) => entry.agentId === agentId,
      ),
    [leadAgentId],
  )
  if (!detail || entries.length === 0) return null
  const coding = orchCoding(detail.coding, detail.quotaFloorPercent)
  return (
    <>
      {entries.map((entry) => (
        <RunPin
          key={entry.key}
          jobId={job.id}
          pinKey={`run:${runId}:${entry.key}`}
          since={detail.updatedAt}
          notice={pinNotice(entry.item)}
          label={pinLabel(entry.item)}
        >
          {orchestrationCard(detail, entry, agents, actions, preflightWorker, coding)}
        </RunPin>
      ))}
    </>
  )
}

function orchestrationCard(
  run: OrchestrationDetail,
  entry: OrchestrationNeedEntry,
  agents: AgentSummary[],
  actions: RunActions,
  preflightWorker: PreflightWorker,
  coding: ReturnType<typeof orchCoding>,
) {
  const { item } = entry
  switch (item.kind) {
    case 'gate':
      return <GateCard run={run} gateId={item.gateId} agents={agents} actions={actions} />
    case 'inquiry':
      return <InquiryCard run={run} inquiryId={item.inquiryId} actions={actions} />
    case 'budget':
      return <LimitsCard run={run} coding={coding} reason={item.reason} actions={actions} />
    case 'unknown':
      return (
        <UnknownCard
          run={run}
          attemptId={item.attemptId}
          actions={actions}
          {...(entry.fenceStepId ? { fenceStepId: entry.fenceStepId } : {})}
        />
      )
    case 'cancel_fence':
      return <CancelFenceCard run={run} stepId={item.stepId} actions={actions} />
    case 'remap':
      return <RemapCard run={run} item={item} agents={agents} actions={actions} />
    case 'policy_changed':
      return (
        <PolicyChangedCard
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
              body: { agentId: item.agentId, ...decision, orchestrationRevision: run.revision },
            })
          }
        />
      )
    case 'quota_low':
      return (
        <QuotaLowCard
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
          data-protected="block"
          className="orch-decision"
        >
          <h3>{needsYouText(item)}</h3>
        </Arrival>
      )
    case 'fence':
      return (
        <Arrival arrivalId="fence" data-protected="block" className="orch-decision">
          <h3>{needsYouText(item)}</h3>
          <p>Review the list on Now to lift the block.</p>
        </Arrival>
      )
  }
}
