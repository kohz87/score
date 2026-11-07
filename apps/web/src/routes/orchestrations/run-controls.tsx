import type { OrchestrationDetail } from '@score/contract'
import { useState } from 'react'
import { isRunOver } from './orch-model.ts'
import { describeOrchError, type DecisionActions } from './orchestration-queries.ts'

export function RunControls({
  run,
  actions,
}: {
  run: Pick<OrchestrationDetail, 'status' | 'revision'>
  actions: Pick<DecisionActions, 'pause' | 'resume' | 'stop'>
}) {
  const [confirming, setConfirming] = useState(false)
  if (isRunOver(run.status)) return null
  const control = { orchestrationRevision: run.revision }
  const error = actions.pause.error ?? actions.resume.error ?? actions.stop.error
  return (
    <div className="orch-controls">
      {run.status === 'running' && (
        <button
          type="button"
          disabled={actions.pause.isPending}
          onClick={() => actions.pause.mutate(control)}
        >
          Pause
        </button>
      )}
      {run.status === 'paused' && (
        <button
          type="button"
          className="orch-primary"
          disabled={actions.resume.isPending}
          onClick={() => actions.resume.mutate(control)}
        >
          Resume
        </button>
      )}
      {run.status !== 'stopping' &&
        (confirming ? (
          <>
            <span className="orch-confirm">
              Stopping ends the run: nothing new starts and anything running is stopped.
            </span>
            <button
              type="button"
              className="orch-danger"
              disabled={actions.stop.isPending}
              onClick={() => {
                actions.stop.mutate(control)
                setConfirming(false)
              }}
            >
              Stop the run
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Keep going
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)}>
            Stop
          </button>
        ))}
      {error ? (
        <p role="alert" className="orch-error">
          {describeOrchError(error)}
        </p>
      ) : null}
    </div>
  )
}
