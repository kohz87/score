import { Arrival } from '../../motion/Arrival.tsx'
import type { WorkflowRunDetail } from '@score/contract'
import { useState } from 'react'
import { ErrorLine } from '../orchestrations/RunDecisions.tsx'
import { labelOf, type Actions } from './workflow-decision-model.ts'

/** A step that was given up on: Retry it (tries left), or stop the run. */
export function RetryCard({
  run,
  nodeId,
  attemptsLeft,
  actions,
}: {
  run: WorkflowRunDetail
  nodeId: string
  attemptsLeft: number
  actions: Pick<Actions, 'retry' | 'stop'>
}) {
  const [sure, setSure] = useState(false)
  const view = run.nodeStates.find((item) => item.nodeId === nodeId)
  const label = labelOf(run, nodeId)
  return (
    <Arrival
      arrivalId={`retry-${nodeId}-${attemptsLeft}`}
      data-protected="block"
      className="orch-decision"
      aria-label={`Retry ${label}`}
    >
      <h3>You stopped waiting for {label}</h3>
      <p>
        You stopped waiting for its try, so the step has no result and nothing after it can start.
        Retry runs it again as a new try ({attemptsLeft} {attemptsLeft === 1 ? 'try' : 'tries'}{' '}
        left), or stop the run.
      </p>
      {attemptsLeft > 0 ? (
        <label className="orch-check">
          <input
            type="checkbox"
            checked={sure}
            onChange={(event) => setSure(event.target.checked)}
          />
          The earlier try may still be running. Score keeps trying to stop it and ignores its late
          result.
        </label>
      ) : (
        <p className="orch-muted">No tries are left for this step.</p>
      )}
      <div className="orch-actions">
        {attemptsLeft > 0 && view && (
          <button
            type="button"
            className="orch-primary"
            disabled={!sure || actions.retry.isPending}
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
