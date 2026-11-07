import { Arrival } from '../../motion/Arrival.tsx'
import type { AgentSummary, WorkflowRunDetail } from '@score/contract'
import { useCallback, useMemo } from 'react'
import { pauseReasonText } from '../orchestrations/orch-model.ts'
import {
  CancelFenceCard,
  GateCard,
  LimitsCard,
  UnknownCard,
} from '../orchestrations/RunDecisions.tsx'
import type { Actions } from './workflow-decision-model.ts'
import { labelOf } from './workflow-decision-model.ts'
import { fetchWorkflowPreflight } from './workflow-queries.ts'
import {
  CodingAgentChangedCard,
  CodingHeldBackCard,
  InputsWithdrawnCard,
  QuotaHeldCard,
  WorkflowCodingLimitCard,
} from './WorkflowCodingCards.tsx'
import type { PreflightWorker } from '../orchestrations/CodingCards.tsx'
import { gateChip } from '../../live/resolved.ts'
import { ResolvedList } from '../../live/ResolvedList.tsx'
import { useRecentlyResolved } from '../../live/use-recently-resolved.ts'
import { NodeGateCard } from './NodeGateCard.tsx'
import { RefusalCard } from './RefusalCard.tsx'
import { RetryCard } from './RetryCard.tsx'
import { WorkflowRemapCard } from './WorkflowRemapCard.tsx'

// The decisions a workflow run asks of the person (contract §15). Each one carries the revision the page showed: the
// run's, plus the node's or gate's own where it names one. A stale page is answered with `409 conflict` and the run is
// read again; nothing is decided on a guess. The cards the orchestration pages already have are reused as they are.

export { NodeGateCard, RefusalCard, RetryCard, WorkflowRemapCard }

/** Every item the run needs from the person, in the order the server lists them. */
export function WorkflowNeeds({
  run,
  agents,
  actions,
}: {
  run: WorkflowRunDetail
  agents: AgentSummary[]
  actions: Actions
}) {
  // The shared cards read a run through these narrow shapes; a workflow supplies them from its own view.
  const gateRun = useMemo(
    () => ({ gates: run.assignmentGates, stepsList: run.steps, revision: run.revision }),
    [run.assignmentGates, run.steps, run.revision],
  )
  // The run's own check of a coding agent: the workflow's preflight, read for that one agent. No lead is involved.
  const { workflowId, version } = run
  const preflightWorker = useCallback<PreflightWorker>(
    async (agentId) =>
      (await fetchWorkflowPreflight(workflowId, version)).workers.find(
        (entry) => entry.agentId === agentId,
      ),
    [workflowId, version],
  )
  // Only a running or paused run can be decided on; while it stops or after it ended the server answers 409 not_open,
  // so only what winding down still needs (unconfirmed attempts, a cancelled step, the fence) is offered.
  const deciding = run.status === 'running' || run.status === 'paused'
  const items = run.needsYou.filter(
    (item) =>
      deciding || item.kind === 'unknown' || item.kind === 'cancel_fence' || item.kind === 'fence',
  )
  const openGates = new Set(
    items.flatMap((item) => (item.kind === 'gate' ? [`${item.gateKind}:${item.gateId}`] : [])),
  )
  // A decided gate stays where it was, as a chip, for a moment.
  const decided = useRecentlyResolved(openGates, (key) => {
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    const gate = (kind === 'node' ? run.nodeGates : run.assignmentGates).find(
      (item) => item.id === id,
    )
    const chip = gate ? gateChip(gate) : null
    return gate && chip ? { label: labelOf(run, gate.nodeId), chip } : null
  })
  if (items.length === 0 && decided.length === 0) return null
  const unknownIds = new Set(
    items.flatMap((item) => (item.kind === 'unknown' ? [item.attemptId] : [])),
  )
  const fenceFor = (attemptId: string): { fenceStepId?: string } => {
    const fence = items.find((item) => item.kind === 'cancel_fence' && item.attemptId === attemptId)
    return fence?.kind === 'cancel_fence' ? { fenceStepId: fence.stepId } : {}
  }
  return (
    <div className="orch-needs" aria-label="Needs you" data-protected="grid">
      <ResolvedList items={decided} />
      {items.map((item) => {
        switch (item.kind) {
          case 'gate':
            return item.gateKind === 'node' ? (
              <NodeGateCard
                key={`g${item.gateId}`}
                run={run}
                gateId={item.gateId}
                actions={actions}
              />
            ) : (
              <GateCard
                key={`a${item.gateId}`}
                run={gateRun}
                gateId={item.gateId}
                agents={agents}
                actions={actions}
                label={labelOf(run, item.nodeId)}
              />
            )
          case 'budget':
            return (
              <LimitsCard
                key={`b${item.reason}`}
                run={run}
                coding={run.coding}
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
                {...(item.nodeId ? { label: labelOf(run, item.nodeId) } : {})}
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
          case 'retry':
            return (
              <RetryCard
                key={`r${item.nodeId}`}
                run={run}
                nodeId={item.nodeId}
                attemptsLeft={item.attemptsLeft}
                actions={actions}
              />
            )
          case 'refusal_limit':
            return (
              <RefusalCard
                key={`f${item.attemptId}`}
                run={run}
                nodeId={item.nodeId}
                refusals={item.refusals}
                actions={actions}
              />
            )
          case 'remap':
            return (
              <WorkflowRemapCard
                key={`m${item.agentId}`}
                run={run}
                item={item}
                agents={agents}
                actions={actions}
              />
            )
          case 'coding_agent_changed':
            return (
              <CodingAgentChangedCard
                key={`cc${item.nodeId}`}
                run={run}
                item={item}
                agents={agents}
                preflightWorker={preflightWorker}
                actions={actions}
              />
            )
          case 'quota_low':
            return (
              <QuotaHeldCard
                key={`ql${item.nodeId}`}
                run={run}
                item={item}
                agents={agents}
                actions={actions}
              />
            )
          case 'coding_limit':
            return <WorkflowCodingLimitCard key="cl" run={run} actions={actions} />
          case 'coding_held_back':
            return (
              <CodingHeldBackCard
                key={`hb${item.nodeId}`}
                run={run}
                nodeId={item.nodeId}
                actions={actions}
              />
            )
          case 'node_inputs_withdrawn':
            return (
              <InputsWithdrawnCard
                key={`iw${item.nodeId}`}
                run={run}
                nodeId={item.nodeId}
                actions={actions}
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
                <h3>{pauseReasonText(item.reason)}</h3>
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
                <h3>Starting work is blocked until you review a list</h3>
                <p>Review the list on Now to lift the block.</p>
              </Arrival>
            )
        }
      })}
    </div>
  )
}
