import { Arrival } from '../../motion/Arrival.tsx'
import type { AgentSummary, WorkflowNeedsYou, WorkflowRunDetail } from '@score/contract'
import { AgentChip, ErrorLine } from '../orchestrations/RunDecisions.tsx'
import { labelOf, type Actions } from './workflow-decision-model.ts'

/** An agent was replaced after the run started. The exact plan of what would be re-created is shown and approved. */
export function WorkflowRemapCard({
  run,
  item,
  agents,
  actions,
}: {
  run: WorkflowRunDetail
  item: Extract<WorkflowNeedsYou, { kind: 'remap' }>
  agents: AgentSummary[]
  actions: Pick<Actions, 'remap' | 'stop'>
}) {
  const gone = item.currentIncarnation === 'untracked'
  const everyStep = run.gatePolicy === 'every-step'
  return (
    <Arrival
      arrivalId={`remap-${item.agentId}`}
      data-protected="block"
      className="orch-decision"
      aria-label={`Replaced ${item.agentId}`}
    >
      <h3>
        <AgentChip agentId={item.agentId} agents={agents} /> was replaced
      </h3>
      <p>
        {gone
          ? 'This agent no longer exists, so its steps can’t run. You can stop the run.'
          : 'This run was started with the earlier agent. Its steps stay blocked until you decide.'}
      </p>
      <dl className="orch-facts">
        <dt>Steps affected</dt>
        <dd>{item.nodeIds.map((id) => labelOf(run, id)).join(', ') || 'None yet'}</dd>
        {!gone && (
          <>
            <dt>Agent at start</dt>
            <dd className="orch-mono">{item.frozenIncarnation}</dd>
            <dt>Agent now</dt>
            <dd className="orch-mono">{item.currentIncarnation}</dd>
          </>
        )}
      </dl>
      {!gone && item.plan.length > 0 && (
        <>
          <p>
            Steps that were never sent are dropped and created again for the new agent, with exactly
            this text.{' '}
            {everyStep ? 'Each one asks you again.' : 'Your decision here is the approval.'} Work
            that may already have been sent keeps going. The change applies to later work.
          </p>
          <ul className="wf-evidence" aria-label="What would be created again">
            {item.plan.map((entry) => (
              <li key={entry.nodeId}>
                <details>
                  <summary>
                    {labelOf(run, entry.nodeId)}{' '}
                    <span className="orch-mono orch-muted">{entry.payloadHash.slice(0, 10)}</span>
                  </summary>
                  <pre className="orch-pre">{entry.payload}</pre>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="orch-actions">
        {!gone && (
          <button
            type="button"
            className="orch-primary"
            disabled={actions.remap.isPending}
            onClick={() =>
              actions.remap.mutate({
                agentId: item.agentId,
                frozenIncarnation: item.frozenIncarnation,
                currentIncarnation: item.currentIncarnation,
                orchestrationRevision: run.revision,
                acknowledge: true,
                plan: item.plan.map(({ nodeId, payloadHash }) => ({ nodeId, payloadHash })),
              })
            }
          >
            Use the new {item.agentId} for this run
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
      <ErrorLine error={actions.remap.error ?? actions.stop.error} />
    </Arrival>
  )
}
