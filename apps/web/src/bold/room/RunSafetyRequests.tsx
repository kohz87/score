import type {
  AgentSummary,
  Job,
  NeedsYou,
  OrchestrationDetail,
  WorkflowNeedsYou,
  WorkflowRunDetail,
} from '@score/contract'
import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
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
  type GateRun,
} from '../../routes/orchestrations/RunDecisions.tsx'
import {
  CodingLimitCard,
  PolicyChangedCard,
  QuotaLowCard,
  type PreflightWorker,
} from '../../routes/orchestrations/CodingCards.tsx'
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

export type CountCards = (id: string, count: number) => void

function useReportedCount(id: string, count: number, report: CountCards) {
  useEffect(() => {
    report(id, count)
  }, [count, id, report])
  useEffect(() => () => report(id, 0), [id, report])
}

export type OrchestrationNeedEntry = {
  key: string
  item: NeedsYou
  fenceStepId?: string
}

/** One card per item the run asks for; a cancelled step that is also unconfirmed stays one card with both choices. */
export function orchestrationNeedEntries(
  run: Pick<OrchestrationDetail, 'needsYou'>,
): OrchestrationNeedEntry[] {
  const unknownIds = new Set(
    run.needsYou.flatMap((item) => (item.kind === 'unknown' ? [item.attemptId] : [])),
  )
  const entries: OrchestrationNeedEntry[] = []
  for (const item of run.needsYou) {
    if (item.kind === 'cancel_fence' && unknownIds.has(item.attemptId)) continue
    if (item.kind === 'unknown') {
      const fence = run.needsYou.find(
        (entry) => entry.kind === 'cancel_fence' && entry.attemptId === item.attemptId,
      )
      entries.push({
        key: `unknown-${item.attemptId}`,
        item,
        ...(fence?.kind === 'cancel_fence' ? { fenceStepId: fence.stepId } : {}),
      })
    } else {
      entries.push({ key: `${item.kind}-${needId(item)}`, item })
    }
  }
  return entries
}

export type WorkflowNeedEntry = {
  key: string
  item: WorkflowNeedsYou
  fenceStepId?: string
}

/** What the workflow still asks of the person; once it stops, only work winding down keeps its card. */
export function workflowNeedEntries(
  run: Pick<WorkflowRunDetail, 'needsYou' | 'status'>,
): WorkflowNeedEntry[] {
  const deciding = run.status === 'running' || run.status === 'paused'
  const items = run.needsYou.filter(
    (item) =>
      deciding || item.kind === 'unknown' || item.kind === 'cancel_fence' || item.kind === 'fence',
  )
  const unknownIds = new Set(
    items.flatMap((item) => (item.kind === 'unknown' ? [item.attemptId] : [])),
  )
  const entries: WorkflowNeedEntry[] = []
  for (const item of items) {
    if (item.kind === 'cancel_fence' && unknownIds.has(item.attemptId)) continue
    if (item.kind === 'unknown') {
      const fence = items.find(
        (entry) => entry.kind === 'cancel_fence' && entry.attemptId === item.attemptId,
      )
      entries.push({
        key: `unknown-${item.attemptId}`,
        item,
        ...(fence?.kind === 'cancel_fence' ? { fenceStepId: fence.stepId } : {}),
      })
    } else {
      entries.push({ key: `${item.kind}-${needId(item)}`, item })
    }
  }
  return entries
}

function needId(item: NeedsYou | WorkflowNeedsYou): string {
  switch (item.kind) {
    case 'gate':
      return item.gateId
    case 'inquiry':
      return item.inquiryId
    case 'budget':
    case 'paused':
    case 'fence':
      return item.reason
    case 'unknown':
      return item.attemptId
    case 'cancel_fence':
      return item.stepId
    case 'remap':
      return item.agentId
    case 'policy_changed':
      return item.stepId
    case 'coding_limit':
      return 'coding_limit' in item && 'stepId' in item ? item.stepId : 'run'
    case 'quota_low':
      return 'stepId' in item ? item.stepId : item.nodeId
    case 'retry':
    case 'refusal_limit':
    case 'coding_agent_changed':
    case 'coding_held_back':
    case 'node_inputs_withdrawn':
      return item.nodeId
  }
}

function pinLabel(item: NeedsYou | WorkflowNeedsYou): string {
  switch (item.kind) {
    case 'gate':
      return 'A step waits for your approval'
    case 'inquiry':
      return 'The lead asks'
    case 'budget':
      return item.reason === 'unknown_spend' ? 'Spend not settled' : 'Budget or deadline'
    case 'paused':
      return 'Paused'
    case 'unknown':
      return 'Not confirmed as ended'
    case 'cancel_fence':
      return 'A stopped step may still run'
    case 'fence':
      return 'Starting work is blocked'
    case 'remap':
      return 'An agent was replaced'
    case 'policy_changed':
    case 'coding_agent_changed':
      return 'Agent settings changed'
    case 'coding_limit':
      return 'Coding step limit'
    case 'quota_low':
      return 'Quota is low'
    case 'retry':
    case 'refusal_limit':
    case 'coding_held_back':
    case 'node_inputs_withdrawn':
      return 'A step needs another try'
  }
}

function RunPin({ label, children }: { label: string; children: ReactNode }) {
  return (
    <article
      className="bold-request bold-run-request"
      data-protected="flex"
      aria-label={`Needs you: ${label}`}
    >
      {children}
    </article>
  )
}

function OrchestrationRunRequests({
  job,
  agents,
  report,
}: {
  job: Job
  agents: AgentSummary[]
  report: CountCards
}) {
  const runId = job.recipe?.ref ?? ''
  const run = useRun(runId)
  const actions = useRunActions(runId)
  const detail = run.data?.snapshot.orchestration
  const entries = detail ? orchestrationNeedEntries(detail) : []
  useReportedCount(`run-${runId}`, entries.length, report)
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
        <RunPin key={entry.key} label={pinLabel(entry.item)}>
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

function WorkflowRunRequests({
  job,
  agents,
  report,
}: {
  job: Job
  agents: AgentSummary[]
  report: CountCards
}) {
  const runId = job.recipe?.ref ?? ''
  const data = useWorkflowRun(runId)
  const actions = useWorkflowRunActions(runId)
  const detail = data.data?.snapshot.run
  const entries = detail ? workflowNeedEntries(detail) : []
  useReportedCount(`workflow-${runId}`, entries.length, report)
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
        <RunPin key={entry.key} label={pinLabel(entry.item)}>
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

/** The recipes among the room's jobs, each routed to the run that owns it. */
export function RunSafetyRequests({
  jobs,
  agents,
  report,
}: {
  jobs: Job[]
  agents: AgentSummary[]
  report: CountCards
}) {
  return (
    <>
      {jobs.map((job) =>
        job.recipe?.kind === 'orchestration' ? (
          <OrchestrationRunRequests key={job.id} job={job} agents={agents} report={report} />
        ) : job.recipe?.kind === 'workflow' ? (
          <WorkflowRunRequests key={job.id} job={job} agents={agents} report={report} />
        ) : null,
      )}
    </>
  )
}
