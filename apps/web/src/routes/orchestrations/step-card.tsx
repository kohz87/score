import type { AgentSummary, AttemptView, OrchestrationDetail, StepView } from '@score/contract'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { AgentChip } from './decision-parts.tsx'
import { stepVisual, usd, visualLabel, type NodeVisual } from './orch-model.ts'
import { heldLine } from './quota-text.ts'
import { time } from './run-panel-format.ts'
import { StepStopButton, StuckStepCard, useNow, type StopStepAction } from './StepStop.tsx'

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

/** Why a step is blocked or was handled the way it was, in everyday words. */
function dispositionText(disposition: string): string {
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

// 'scan_stack' → 'scan: stack'
const helperRoleLabel = (role: string) => role.replace(/^scan[_:\s]+/, 'scan: ')

export function StepCard({
  step,
  run,
  agents,
  selected,
  onSelect,
  open,
  stop,
}: {
  step: StepView
  run: OrchestrationDetail
  agents: AgentSummary[]
  selected?: boolean
  onSelect?: (id: string) => void
  open?: boolean
  /** 3.14: when given, a running or queued step shows Stop, and a quiet one the stuck card. */
  stop?: StopStepAction
}) {
  // Only a card that can show Stop keeps a clock (review: every card ticked, even without Stop).
  const now = useNow(stop !== undefined)
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
        {step.role === 'helper' && step.helperRole && (
          <span className="orch-helper-role">{helperRoleLabel(step.helperRole)}</span>
        )}
        {onSelect && (
          <button type="button" className="orch-link" onClick={() => onSelect(step.id)}>
            Show in log
          </button>
        )}
        {stop && <StepStopButton step={step} run={run} stop={stop} now={now} />}
      </header>
      {stop && (
        <StuckStepCard
          step={step}
          run={run}
          agentName={agents.find((item) => item.id === step.agentId)?.name ?? step.agentId}
          stop={stop}
          now={now}
        />
      )}
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
