import type { AgentSummary, Job, WorkflowRunDetail } from '@score/contract'
import { useCallback, useMemo } from 'react'
import { Arrival } from '../../motion/Arrival.tsx'
import { needsYouText } from '../../routes/orchestrations/orch-model.ts'
import {
  CancelFenceCard,
  GateCard,
  LimitsCard,
  UnknownCard,
  type GateRun,
} from '../../routes/orchestrations/RunDecisions.tsx'
import type { PreflightWorker } from '../../routes/orchestrations/CodingCards.tsx'
import {
  NodeGateCard,
  RefusalCard,
  RetryCard,
  WorkflowRemapCard,
} from '../../routes/workflows/WorkflowDecisions.tsx'
import {
  CodingAgentChangedCard,
  CodingHeldBackCard,
  InputsWithdrawnCard,
  QuotaHeldCard,
  WorkflowCodingLimitCard,
} from '../../routes/workflows/WorkflowCodingCards.tsx'
import {
  fetchWorkflowPreflight,
  useWorkflowRun,
  useWorkflowRunActions,
  type WorkflowRunActions,
} from '../../routes/workflows/workflow-queries.ts'
import { pinLabel, pinNotice, RunPin } from './RunSafetyPins.tsx'
import { workflowNeedEntries, type WorkflowNeedEntry } from './run-safety-entries.ts'

export function WorkflowRunRequests({ job, agents }: { job: Job; agents: AgentSummary[] }) {
  const runId = job.recipe?.ref ?? ''
  const data = useWorkflowRun(runId)
  const actions = useWorkflowRunActions(runId)
  const detail = data.data?.snapshot.run
  const entries = detail ? workflowNeedEntries(detail) : []
  const gateRun = useMemo(
    () =>
      detail
        ? {
            gates: detail.assignmentGates,
            stepsList: detail.steps,
            revision: detail.revision,
          }
        : null,
    [detail],
  )
  const workflowId = detail?.workflowId ?? ''
  const version = detail?.version ?? 0
  const preflightWorker = useCallback<PreflightWorker>(
    async (agentId) =>
      (await fetchWorkflowPreflight(workflowId, version)).workers.find(
        (entry) => entry.agentId === agentId,
      ),
    [workflowId, version],
  )
  if (!detail || !gateRun || entries.length === 0) return null
  return (
    <>
      {entries.map((entry) => (
        <RunPin
          key={entry.key}
          jobId={job.id}
          pinKey={`workflow:${runId}:${entry.key}`}
          since={detail.updatedAt}
          notice={pinNotice(entry.item)}
          label={pinLabel(entry.item)}
        >
          {workflowCard(detail, entry, gateRun, agents, actions, preflightWorker)}
        </RunPin>
      ))}
    </>
  )
}

function workflowCard(
  run: WorkflowRunDetail,
  entry: WorkflowNeedEntry,
  gateRun: GateRun,
  agents: AgentSummary[],
  actions: WorkflowRunActions,
  preflightWorker: PreflightWorker,
) {
  const { item } = entry
  switch (item.kind) {
    case 'gate':
      return item.gateKind === 'node' ? (
        <NodeGateCard run={run} gateId={item.gateId} actions={actions} />
      ) : (
        <GateCard run={gateRun} gateId={item.gateId} agents={agents} actions={actions} />
      )
    case 'budget':
      return <LimitsCard run={run} coding={run.coding} reason={item.reason} actions={actions} />
    case 'unknown':
      return (
        <UnknownCard
          run={run}
          attemptId={item.attemptId}
          actions={actions}
          {...(item.nodeId ? { label: nodeLabel(run, item.nodeId) } : {})}
          {...(entry.fenceStepId ? { fenceStepId: entry.fenceStepId } : {})}
        />
      )
    case 'cancel_fence':
      return <CancelFenceCard run={run} stepId={item.stepId} actions={actions} />
    case 'retry':
      return (
        <RetryCard
          run={run}
          nodeId={item.nodeId}
          attemptsLeft={item.attemptsLeft}
          actions={actions}
        />
      )
    case 'refusal_limit':
      return (
        <RefusalCard run={run} nodeId={item.nodeId} refusals={item.refusals} actions={actions} />
      )
    case 'remap':
      return <WorkflowRemapCard run={run} item={item} agents={agents} actions={actions} />
    case 'coding_agent_changed':
      return (
        <CodingAgentChangedCard
          run={run}
          item={item}
          agents={agents}
          preflightWorker={preflightWorker}
          actions={actions}
        />
      )
    case 'quota_low':
      return <QuotaHeldCard run={run} item={item} agents={agents} actions={actions} />
    case 'coding_limit':
      return <WorkflowCodingLimitCard run={run} actions={actions} />
    case 'coding_held_back':
      return <CodingHeldBackCard run={run} nodeId={item.nodeId} actions={actions} />
    case 'node_inputs_withdrawn':
      return <InputsWithdrawnCard run={run} nodeId={item.nodeId} actions={actions} />
    case 'paused':
      return (
        <Arrival
          arrivalId={`paused-${item.reason}`}
          data-protected="block"
          className="orch-decision"
        >
          <h3>{needsYouText({ kind: 'paused', reason: item.reason })}</h3>
        </Arrival>
      )
    case 'fence':
      return (
        <Arrival arrivalId="fence" data-protected="block" className="orch-decision">
          <h3>Starting work is blocked until you review a list</h3>
          <p>Review the list on Now to lift the block.</p>
        </Arrival>
      )
  }
}

const nodeLabel = (run: Pick<WorkflowRunDetail, 'definition'>, nodeId: string): string =>
  run.definition.nodes.find((node) => node.id === nodeId)?.label ?? nodeId
