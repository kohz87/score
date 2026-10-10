import type { AgentSummary, AttemptView, OrchestrationDetail, StepView } from '@score/contract'
import { useState } from 'react'
import {
  isRunOver,
  pauseReasonText,
  statusLabel,
  stepVisual,
  usd,
  visualLabel,
  type NodeVisual,
} from './orch-model.ts'
import { describeOrchError, type RunActions } from './orchestration-queries.ts'
import { AgentChip } from './RunDecisions.tsx'

const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : null

/** A small shape + word + colour marker for a step state (never colour alone). */
export function StateMark({ visual }: { visual: NodeVisual }) {
  return (
    <span className={`orch-state orch-state--${visual}`}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        {visual === 'succeeded' ? (
          <path d="M2 6.5 L5 9.5 L10 3" fill="none" stroke="currentColor" strokeWidth="2" />
        ) : visual === 'failed' || visual === 'rejected' || visual === 'blocked' ? (
          <path d="M3 3 L9 9 M9 3 L3 9" fill="none" stroke="currentColor" strokeWidth="2" />
        ) : visual === 'unknown' || visual === 'abandoned' ? (
          <text x="6" y="10" textAnchor="middle" fontSize="11" fill="currentColor">
            ?
          </text>
        ) : visual === 'gate' ? (
          <path d="M6 1 L11 6 L6 11 L1 6 Z" fill="currentColor" />
        ) : visual === 'running' || visual === 'admitting' ? (
          <circle cx="6" cy="6" r="4" fill="currentColor" />
        ) : visual === 'cancelled' || visual === 'not_started' ? (
          <path d="M2 6 H10" fill="none" stroke="currentColor" strokeWidth="2" />
        ) : (
          <circle
            cx="6"
            cy="6"
            r="3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="2 2"
          />
        )}
      </svg>
      {visualLabel[visual]}
    </span>
  )
}

export function RunControls({ run, actions }: { run: OrchestrationDetail; actions: RunActions }) {
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
              Stop admits nothing more and stops what is running.
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

export function RunStatus({ run }: { run: OrchestrationDetail }) {
  return (
    <div className="orch-status">
      <span className={`orch-badge orch-badge--${run.status}`}>{statusLabel[run.status]}</span>
      {run.status === 'paused' && <span>{pauseReasonText(run.pauseReason)}</span>}
      {run.ownership !== 'released' && isRunOver(run.status) && (
        <span title="Score still owes Hermes a Stop, or an attempt is not confirmed ended">
          Not fully wound down (ownership: {run.ownership})
        </span>
      )}
      {run.endReason && <span>{run.endReason}</span>}
      <span className="orch-muted">
        Lead turn {run.leadTurnsUsed} of {run.maxLeadTurns}, {run.steps.succeeded} of{' '}
        {run.steps.total} steps done
      </span>
    </div>
  )
}

export function BudgetBlock({ run }: { run: OrchestrationDetail }) {
  const b = run.budget
  return (
    <dl className="orch-facts orch-budget" aria-label="Budget">
      <dt>Budget</dt>
      <dd>
        {b.limitUsd === null ? 'No limit set' : `${usd(b.limitUsd)}, ${usd(b.remainingUsd)} left`}
      </dd>
      <dt>Settled</dt>
      <dd>{usd(b.settledUsd)}</dd>
      <dt>Provisional</dt>
      <dd>{usd(b.provisionalUsd)} (still moving; counted against the budget)</dd>
      <dt>Reserved</dt>
      <dd>{usd(b.reservedUsd)} for work not yet started</dd>
      <dt>Complete</dt>
      <dd>
        {b.complete ? 'Yes: every attempt is settled' : 'No: some attempts are not settled yet'}
        {b.unknownSpend ? '; some spend is unknown and is never counted as zero' : ''}
      </dd>
      <dd className="orch-muted orch-wide">
        Estimates are per lead turn ({usd(run.leadTurnEstimateUsd)}) and per step (
        {usd(run.stepEstimateUsd)}). Summaries and titles are not counted.
      </dd>
    </dl>
  )
}

function AttemptLine({ attempt }: { attempt: AttemptView }) {
  const evidence = attempt.evidence
    ? `ended (Hermes reported ${attempt.evidence})`
    : attempt.state === 'abandoned'
      ? 'abandoned by you'
      : attempt.state === 'unknown'
        ? `not confirmed ended${attempt.unknownReason ? `: ${attempt.unknownReason}` : ''}`
        : attempt.state.replace('_', ' ')
  const owed =
    attempt.stopRequestedAt && !attempt.stopAcknowledgedAt && !attempt.evidence
      ? `Stop owed since ${time(attempt.stopRequestedAt)}, not acknowledged`
      : attempt.stopRequestedAt
        ? `Stop asked ${time(attempt.stopRequestedAt)}${attempt.stopAcknowledgedAt ? `, acknowledged ${time(attempt.stopAcknowledgedAt)}` : ''}`
        : null
  return (
    <li>
      Attempt {attempt.n} by {attempt.agentId}: {evidence}
      {attempt.retired ? ', retired' : ''}. Spend{' '}
      {attempt.spendUsd === null ? 'unknown' : usd(attempt.spendUsd)}
      {attempt.spendComplete ? '' : ' (not complete)'}.{owed ? ` ${owed}.` : ''}
    </li>
  )
}

export function StepCard({
  step,
  run,
  agents,
  selected,
  onSelect,
  open,
}: {
  step: StepView
  run: OrchestrationDetail
  agents: AgentSummary[]
  selected?: boolean
  onSelect?: (id: string) => void
  open?: boolean
}) {
  const attempts = run.attempts.filter((attempt) => attempt.stepId === step.id)
  const visual = stepVisual(step, attempts.at(-1))
  const preview = step.result ? step.result.replace(/\s+/g, ' ').slice(0, 200) : null
  return (
    <article
      className={`orch-step${selected ? ' orch-step--on' : ''}`}
      aria-label={`${step.id}, ${visualLabel[visual]}`}
    >
      <header>
        <strong>{step.id}</strong>
        <AgentChip agentId={step.agentId} agents={agents} />
        <StateMark visual={visual} />
        {onSelect && (
          <button type="button" className="orch-link" onClick={() => onSelect(step.id)}>
            Show in log
          </button>
        )}
      </header>
      <p className="orch-step-instruction">{step.instruction}</p>
      <p className="orch-muted">
        {step.after.length > 0 && <>After {step.after.join(', ')}. </>}
        {step.replaces && <>Replaces {step.replaces}. </>}
        {step.disposition && <>Disposition: {step.disposition}. </>}
        {step.gateId && <>Gate {step.gateId}. </>}
        Estimate {usd(step.estimateUsd)}.
      </p>
      {preview && (
        <details open={open}>
          <summary>
            Result (version {step.resultRevision}): {preview.length < 200 ? preview : `${preview}…`}
          </summary>
          <pre className="orch-pre">{step.result}</pre>
        </details>
      )}
      {attempts.length > 0 && (
        <details>
          <summary>
            {attempts.length} attempt{attempts.length === 1 ? '' : 's'}
          </summary>
          <ul className="orch-attempts">
            {attempts.map((attempt) => (
              <AttemptLine key={attempt.id} attempt={attempt} />
            ))}
          </ul>
        </details>
      )}
    </article>
  )
}

export function FinishBlock({ run }: { run: OrchestrationDetail }) {
  const stillOwed = run.attempts.filter((attempt) => run.unconfirmed.includes(attempt.id))
  if (!run.finish && stillOwed.length === 0 && run.cancelFence.length === 0) return null
  return (
    <section className="orch-finish" aria-label="Finish">
      {run.finish && (
        <>
          <h3>
            The lead finished: {run.finish.outcome}{' '}
            <small>asked {time(run.finish.requestedAt)}</small>
          </h3>
          <p>{run.finish.summary}</p>
        </>
      )}
      {stillOwed.length > 0 && (
        <>
          <h3>Not confirmed ended</h3>
          <p>
            Score keeps asking Hermes to stop these until it confirms. A Stop being acknowledged is
            not proof that the run ended.
          </p>
          <ul className="orch-attempts">
            {stillOwed.map((attempt) => (
              <AttemptLine key={attempt.id} attempt={attempt} />
            ))}
          </ul>
        </>
      )}
      {run.cancelFence.length > 0 && (
        <p>
          Admission is fenced until cancelled work ends:{' '}
          {run.cancelFence.map((item) => item.stepId).join(', ')}.
        </p>
      )}
    </section>
  )
}

export function PlanList({ run }: { run: OrchestrationDetail }) {
  if (run.plan.length === 0)
    return <p className="orch-muted">The lead has not recorded a plan yet.</p>
  return (
    <ol className="orch-plan" aria-label="Plan">
      {run.plan.map((entry, index) => (
        <li key={index}>{entry}</li>
      ))}
    </ol>
  )
}
