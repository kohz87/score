import { runtimeLabel } from '../../components/runtime-label.ts'
import type {
  AgentSummary,
  AttemptView,
  BudgetView,
  OrchestrationDetail,
  StepView,
} from '@score/contract'
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
import { describeOrchError, type DecisionActions } from './orchestration-queries.ts'
import type { RunCoding } from './CodingCards.tsx'
import { heldLine } from './quota-text.ts'
import { AgentChip, sourceName } from './decision-parts.tsx'
import { LiveCount } from '../../live/LiveCount.tsx'
import { RunSummary } from '../../live/RunSummary.tsx'
import { secondsBetween } from '../../live/run-summary.ts'

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
        ) : visual === 'cancelled' || visual === 'not_started' || visual === 'skipped' ? (
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

export function RunStatus({
  run,
  badge = true,
}: {
  run: OrchestrationDetail
  /** The room panel already shows the badge in its sticky header. */
  badge?: boolean
}) {
  return (
    <div className="orch-status">
      {badge && (
        <span className={`orch-badge orch-badge--${run.status}`}>{statusLabel[run.status]}</span>
      )}
      {run.status === 'paused' && <span>{pauseReasonText(run.pauseReason)}</span>}
      {run.ownership !== 'released' && isRunOver(run.status) && (
        <span title="Score still has to send Hermes a stop, or some work isn’t confirmed as ended">
          Not fully stopped yet
        </span>
      )}
      {run.endReason && <span>{run.endReason}</span>}
      <span className="orch-muted">
        Lead turn <LiveCount value={run.leadTurnsUsed} /> of {run.maxLeadTurns},{' '}
        <LiveCount value={run.steps.succeeded} /> of {run.steps.total} steps done
      </span>
      <RunSpend budget={run.budget} />
    </div>
  )
}

const spendFormat = (value: number) => usd(value)
/** Spend so far, counting up as it grows. Shown only once something has been reported: unknown is not zero. */
export function RunSpend({ budget }: { budget: BudgetView }) {
  const total = budget.settledUsd + budget.provisionalUsd
  if (!(total > 0)) return null
  return (
    <span className="orch-muted">
      Spend <LiveCount value={total} format={spendFormat} />
      {budget.complete ? '' : ', not settled'}
    </span>
  )
}

/** The facts of a run that has ended, in the slot below its status (empty while it runs, so nothing moves). */
export function EndSummary({
  run,
  steps,
  approvals,
}: {
  run: {
    status: OrchestrationDetail['status']
    createdAt: string
    endedAt: string | null
    budget: BudgetView
  }
  steps: number
  approvals: number
}) {
  const total = run.budget.settledUsd + run.budget.provisionalUsd
  return (
    <div className="orch-summary-slot">
      {isRunOver(run.status) && (
        <RunSummary
          failed={run.status === 'failed'}
          facts={{
            steps,
            approvals,
            spendUsd: total > 0 ? total : null,
            spendEstimated: !run.budget.complete,
            durationSec: secondsBetween(run.createdAt, run.endedAt),
          }}
        />
      )}
    </div>
  )
}

export function BudgetBlock({
  run,
  coding,
}: {
  run: Pick<OrchestrationDetail, 'budget' | 'stepEstimateUsd'> & { leadTurnEstimateUsd?: number }
  /** The run's current coding authorisation; absent for a run without coding agents. */
  coding?: RunCoding | undefined
}) {
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
      <dd>{usd(b.provisionalUsd)} (may still change; counted against the budget)</dd>
      <dt>Reserved</dt>
      <dd>{usd(b.reservedUsd)} for work not yet started</dd>
      {coding && (
        <>
          <dt>Coding steps</dt>
          <dd>
            {coding.used === undefined
              ? `Up to ${coding.codingSteps}`
              : `${coding.used} of ${coding.codingSteps} used`}
            {coding.unknownSpend === 'continue'
              ? '; you accepted unknown cost for every source'
              : coding.acceptedUnknownCost.length > 0
                ? `; you accepted unknown cost for ${coding.acceptedUnknownCost.map(sourceName).join(' and ')}`
                : ''}
          </dd>
        </>
      )}
      {coding && (
        <>
          <dt>Quota floor</dt>
          <dd>
            {coding.quotaFloorPercent === null || coding.quotaFloorPercent === undefined
              ? 'Each coding agent’s own'
              : coding.quotaFloorPercent === 0
                ? 'Off for this run'
                : `${coding.quotaFloorPercent}% for this run`}
            ; a coding agent with less of a limit left than that gets no new steps
          </dd>
        </>
      )}
      <dt>Complete</dt>
      <dd>
        {b.complete ? 'Yes: all spend is settled' : 'No: some spend isn’t settled yet'}
        {b.unknownSpend ? '; some spend is unknown and never counted as zero' : ''}
      </dd>
      <dd className="orch-muted orch-wide">
        {run.leadTurnEstimateUsd === undefined ? (
          <>Estimates are per step ({usd(run.stepEstimateUsd)}).</>
        ) : (
          <>
            Estimates are per lead turn ({usd(run.leadTurnEstimateUsd)}) and per step (
            {usd(run.stepEstimateUsd)}).
          </>
        )}{' '}
        Summaries and titles aren’t counted.
      </dd>
    </dl>
  )
}

/** Why a step is blocked or was handled the way it was, in everyday words. */
export function dispositionText(disposition: string): string {
  if (disposition === 'agent_changed')
    return 'Blocked: the agent changed after you approved this run.'
  if (disposition === 'permission_forbidden')
    return 'Blocked: the agent has full access, which orchestration and workflow steps can’t use.'
  if (disposition === 'coding_limit') return 'Blocked: the run reached its limit of coding steps.'
  if (disposition === 'quota_low') return 'Held: the agent’s limit is low.'
  return `Handled as: ${disposition}.`
}

export function AttemptLine({
  attempt,
  agents = [],
}: {
  attempt: AttemptView
  agents?: AgentSummary[]
}) {
  // Who reported the end: Hermes for its own agents, the coding agent's program otherwise.
  const reporter =
    runtimeLabel(agents.find((agent) => agent.id === attempt.agentId)?.runtime) ?? 'Hermes'
  const evidence = attempt.evidence
    ? `ended (${reporter} reported ${attempt.evidence})`
    : attempt.state === 'abandoned'
      ? 'you stopped waiting for it'
      : attempt.state === 'unknown'
        ? `not confirmed as ended${attempt.unknownReason ? `: ${attempt.unknownReason.replaceAll('_', ' ')}` : ''}`
        : attempt.state.replace('_', ' ')
  const owed =
    attempt.stopRequestedAt && !attempt.stopAcknowledgedAt && !attempt.evidence
      ? `Stop requested at ${time(attempt.stopRequestedAt)}, not yet acknowledged`
      : attempt.stopRequestedAt
        ? `Stop requested at ${time(attempt.stopRequestedAt)}${attempt.stopAcknowledgedAt ? `, acknowledged ${time(attempt.stopAcknowledgedAt)}` : ''}`
        : null
  return (
    <li>
      Try {attempt.n} by {attempt.agentId}: {evidence}
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
        {step.quotaHold ? (
          <>{heldLine(step.quotaHold)} </>
        ) : (
          step.disposition && <>{dispositionText(step.disposition)} </>
        )}
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
            {attempts.length} {attempts.length === 1 ? 'try' : 'tries'}
          </summary>
          <ul className="orch-attempts">
            {attempts.map((attempt) => (
              <AttemptLine key={attempt.id} attempt={attempt} agents={agents} />
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
          <h3>Not confirmed as ended</h3>
          <p>
            Score keeps asking the agent to stop these until it confirms. A stop being acknowledged
            doesn’t prove that the run ended.
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
          Nothing new starts until stopped work ends:{' '}
          {run.cancelFence.map((item) => item.stepId).join(', ')}.
        </p>
      )}
    </section>
  )
}

export function PlanList({ run }: { run: OrchestrationDetail }) {
  if (run.plan.length === 0)
    return <p className="orch-muted">The lead hasn’t recorded a plan yet.</p>
  return (
    <ol className="orch-plan" aria-label="Plan">
      {run.plan.map((entry, index) => (
        <li key={index}>{entry}</li>
      ))}
    </ol>
  )
}
