import type { OrchestrationDetail } from '@score/contract'
import { useState } from 'react'
import { Arrival } from '../../motion/Arrival.tsx'
import { ErrorLine } from './decision-parts.tsx'
import type { DecisionActions } from './orchestration-queries.ts'
import type { AttemptsRun } from './run-decision-types.ts'

export function UnknownCard({
  run,
  attemptId,
  actions,
  fenceStepId,
  label,
}: {
  run: AttemptsRun
  attemptId: string
  /** What the card calls the step (a workflow names the node). */
  label?: string
  actions: Pick<DecisionActions, 'abandon' | 'waiver'>
  /** The same attempt also fences the run as a cancelled step: its waiver is offered on this card. */
  fenceStepId?: string
}) {
  const attempt = run.attempts.find((item) => item.id === attemptId)
  const [sure, setSure] = useState(false)
  const [waive, setWaive] = useState(false)
  if (!attempt) return null
  return (
    <Arrival
      arrivalId={`unknown-${attemptId}`}
      data-protected="block"
      className="orch-decision"
      aria-label="Not confirmed as ended"
    >
      <h3>Not confirmed as ended: {label ?? attempt.stepId ?? 'lead turn'}</h3>
      <p>
        {attempt.unknownReason === 'run_cancelled' && attempt.stopRequestedAt
          ? 'Hermes cancelled the run after it was stopped, but doesn’t confirm that everything the agent started (a tool call, a command) has finished.'
          : `Hermes hasn’t said this work finished (${unknownReasonText(attempt.unknownReason)}).`}{' '}
        Score keeps trying to stop it. Until it ends, nothing new starts.
      </p>
      <p className="small">
        Stop waiting for this marks this work as failed and stops waiting for it. Score still asks
        Hermes to stop it and ignores anything it sends later. A running job then pauses for you to
        decide; a job being stopped finishes stopping.
      </p>
      <label className="orch-check">
        <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
        This may still be running. Score keeps trying to stop it and ignores any late results.
      </label>
      <div className="orch-actions">
        <button
          type="button"
          disabled={!sure || actions.abandon.isPending}
          onClick={() =>
            actions.abandon.mutate({
              attemptIds: [attemptId],
              orchestrationRevision: run.revision,
              acknowledge: true,
            })
          }
        >
          Stop waiting for this
        </button>
      </div>
      <ErrorLine error={actions.abandon.error} />
      {fenceStepId && (
        <>
          <p>
            It is also the stopped step {fenceStepId}: nothing new starts until it has ended. You
            can continue while it may still run instead. That is recorded; it doesn’t prove that it
            stopped.
          </p>
          <label className="orch-check">
            <input
              type="checkbox"
              checked={waive}
              onChange={(event) => setWaive(event.target.checked)}
            />
            Continue while the stopped step may still run.
          </label>
          <div className="orch-actions">
            <button
              type="button"
              disabled={!waive || actions.waiver.isPending}
              onClick={() =>
                actions.waiver.mutate({ orchestrationRevision: run.revision, acknowledge: true })
              }
            >
              Continue anyway
            </button>
          </div>
          <ErrorLine error={actions.waiver.error} />
        </>
      )}
    </Arrival>
  )
}

export function CancelFenceCard({
  run,
  stepId,
  actions,
}: {
  run: Pick<OrchestrationDetail, 'revision'>
  stepId: string
  actions: Pick<DecisionActions, 'waiver'>
}) {
  const [sure, setSure] = useState(false)
  return (
    <Arrival
      arrivalId={`cancel-${stepId}`}
      data-protected="block"
      className="orch-decision"
      aria-label="Stopped step may still run"
    >
      <h3>Stopped {stepId} may still be running</h3>
      <p>
        Nothing new starts until it has ended. You can also continue while it may still run. That is
        recorded; it doesn’t prove that it stopped.
      </p>
      <label className="orch-check">
        <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
        Continue while the stopped step may still run.
      </label>
      <div className="orch-actions">
        <button
          type="button"
          disabled={!sure || actions.waiver.isPending}
          onClick={() =>
            actions.waiver.mutate({ orchestrationRevision: run.revision, acknowledge: true })
          }
        >
          Continue anyway
        </button>
      </div>
      <ErrorLine error={actions.waiver.error} />
    </Arrival>
  )
}

/** 3.7.12: why an attempt isn't confirmed as ended, in plain words. */
function unknownReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case 'run_cancelled':
      return 'the run was cancelled'
    case 'run_interrupted':
      return 'the run was interrupted'
    case 'recovered_text_only':
      return 'only its text came back'
    case 'crash_after_send_started':
      return 'Score restarted while sending it'
    case 'run_not_proven_ended':
      return 'its end isn’t proven'
    case 'admission_uncertain':
      return 'Score can’t tell whether Hermes took it'
    case 'refusal_unjournaled':
    case 'closure_unjournaled':
      return 'Score couldn’t record how it ended'
    case 'generation_missing':
      return 'Score lost track of which start this was'
    case 'run_failed':
      return 'the run failed without proof it stopped'
    case null:
    case undefined:
      return 'no reason recorded'
    default:
      return reason.replaceAll('_', ' ')
  }
}
