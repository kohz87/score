import { Arrival } from '../../motion/Arrival.tsx'
import type { WorkflowRunDetail } from '@score/contract'
import { ErrorLine } from '../orchestrations/RunDecisions.tsx'
import { labelOf, type Actions } from './workflow-decision-model.ts'

/** Hermes refused a step over and over: Score stopped trying on its own. */
export function RefusalCard({
  run,
  nodeId,
  refusals,
  actions,
}: {
  run: WorkflowRunDetail
  nodeId: string
  refusals: number
  actions: Pick<Actions, 'tryAgain' | 'stop'>
}) {
  const view = run.nodeStates.find((item) => item.nodeId === nodeId)
  const label = labelOf(run, nodeId)
  return (
    <Arrival
      arrivalId={`refused-${nodeId}-${refusals}`}
      data-protected="block"
      className="orch-decision"
      aria-label={`Hermes refused ${label}`}
    >
      <h3>Hermes has refused this step {refusals} times</h3>
      <p>
        {label} hasn’t started: Hermes turned the request away each time, so nothing ran. Score
        stopped asking. Try again keeps the same step and asks Hermes once more, or you can stop the
        run.
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
