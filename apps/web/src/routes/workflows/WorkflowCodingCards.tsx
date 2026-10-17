import { WORKFLOW_LIMITS } from '@score/contract'
import type { AgentSummary, WorkflowNeedsYou, WorkflowRunDetail } from '@score/contract'
import { Arrival } from '../../motion/Arrival.tsx'
import {
  CodingLimitCard,
  PolicyChangedCard,
  type PreflightWorker,
} from '../orchestrations/CodingCards.tsx'
import { ErrorLine } from '../orchestrations/decision-parts.tsx'
import type { WorkflowRunActions } from './workflow-queries.ts'

// The four decisions a workflow run asks for coding steps (contract §15, 7.7c). The settings and limit cards are the
// shared ones, fed from the run's `coding` block and the workflow's own endpoints; the other two are about one step.

const labelOf = (run: Pick<WorkflowRunDetail, 'definition'>, nodeId: string): string =>
  run.definition.nodes.find((node) => node.id === nodeId)?.label ?? nodeId

/** A coding agent's settings changed: "Use the new settings" for this step (the step's policy-only remap). */
export function CodingAgentChangedCard({
  run,
  item,
  agents,
  preflightWorker,
  actions,
}: {
  run: WorkflowRunDetail
  item: Extract<WorkflowNeedsYou, { kind: 'coding_agent_changed' }>
  agents: AgentSummary[]
  preflightWorker: PreflightWorker
  actions: Pick<WorkflowRunActions, 'policyRemap'>
}) {
  const view = run.nodeStates.find((entry) => entry.nodeId === item.nodeId)
  if (!view) return null
  return (
    <PolicyChangedCard
      scope={run.id}
      arrivalKey={item.nodeId}
      what={labelOf(run, item.nodeId)}
      agentId={item.agentId}
      agents={agents}
      preflightWorker={preflightWorker}
      pending={actions.policyRemap.isPending}
      error={actions.policyRemap.error}
      onUse={(decision) =>
        actions.policyRemap.mutate({
          nodeId: item.nodeId,
          body: {
            ...decision,
            expectedNodeRevision: view.revision,
            orchestrationRevision: run.revision,
          },
        })
      }
    />
  )
}

/** The run's coding step limit is used up: raise it and the waiting step goes on. */
export function WorkflowCodingLimitCard({
  run,
  actions,
}: {
  run: WorkflowRunDetail
  actions: Pick<WorkflowRunActions, 'limits'>
}) {
  if (!run.coding) return null
  return (
    <CodingLimitCard
      arrivalKey={run.id}
      waiting={null}
      coding={run.coding}
      pending={actions.limits.isPending}
      error={actions.limits.error}
      onRaise={(codingSteps) =>
        actions.limits.mutate({ orchestrationRevision: run.revision, codingSteps })
      }
    />
  )
}

/** Score prepared a coding step 20 times and it never started: Try again renews it (a few times), or stop the run. */
export function CodingHeldBackCard({
  run,
  nodeId,
  actions,
}: {
  run: WorkflowRunDetail
  nodeId: string
  actions: Pick<WorkflowRunActions, 'tryAgain' | 'stop'>
}) {
  const view = run.nodeStates.find((item) => item.nodeId === nodeId)
  const label = labelOf(run, nodeId)
  const left = Math.max(0, WORKFLOW_LIMITS.maxRenewalsPerNode - (view?.renewals ?? 0))
  return (
    <Arrival
      arrivalId={`held-back-${nodeId}-${view?.renewals ?? 0}`}
      data-protected="block"
      className="orch-decision"
      aria-label={`${label} was held back`}
    >
      <h3>{label} was held back 20 times</h3>
      <p>
        Score got {label} ready 20 times and each time held it back before it started, so nothing
        ran. Try again gets it ready once more ({left} {left === 1 ? 'chance' : 'chances'} left for
        this step), or you can stop the run.
      </p>
      <div className="orch-actions">
        {view && (
          <button
            type="button"
            className="orch-primary"
            disabled={actions.tryAgain.isPending}
            onClick={() =>
              actions.tryAgain.mutate({
                nodeId,
                body: {
                  expectedNodeRevision: view.revision,
                  orchestrationRevision: run.revision,
                },
              })
            }
          >
            Try again
          </button>
        )}
        <button
          type="button"
          disabled={actions.stop.isPending}
          onClick={() => actions.stop.mutate({ orchestrationRevision: run.revision })}
        >
          Stop the run
        </button>
      </div>
      <ErrorLine error={actions.tryAgain.error ?? actions.stop.error} />
    </Arrival>
  )
}

/** What a coding step was going to read was taken back before it started: nothing of it ran. */
export function InputsWithdrawnCard({
  run,
  nodeId,
  actions,
}: {
  run: WorkflowRunDetail
  nodeId: string
  actions: Pick<WorkflowRunActions, 'retry' | 'stop'>
}) {
  const view = run.nodeStates.find((item) => item.nodeId === nodeId)
  const label = labelOf(run, nodeId)
  return (
    <Arrival
      arrivalId={`withdrawn-${nodeId}-${view?.revision ?? 0}`}
      data-protected="block"
      className="orch-decision"
      aria-label={`${label} lost its input`}
    >
      <h3>{label} lost something it was going to read</h3>
      <p>
        A result {label} was going to read was taken back before it started, so nothing ran and the
        try wasn’t used. Run the step before it again if it needs to, then Retry starts {label}{' '}
        again with what is there then. Or stop the run.
      </p>
      <div className="orch-actions">
        {view?.canRetry && (
          <button
            type="button"
            className="orch-primary"
            disabled={actions.retry.isPending}
            onClick={() =>
              actions.retry.mutate({
                nodeId,
                body: {
                  expectedNodeRevision: view.revision,
                  orchestrationRevision: run.revision,
                  acknowledge: true,
                },
              })
            }
          >
            Retry {label}
          </button>
        )}
        <button
          type="button"
          disabled={actions.stop.isPending}
          onClick={() => actions.stop.mutate({ orchestrationRevision: run.revision })}
        >
          Stop the run
        </button>
      </div>
      <ErrorLine error={actions.retry.error ?? actions.stop.error} />
    </Arrival>
  )
}
