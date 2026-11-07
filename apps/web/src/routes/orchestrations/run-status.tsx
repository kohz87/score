import type { BudgetView, OrchestrationDetail } from '@score/contract'
import { LiveCount } from '../../live/LiveCount.tsx'
import { RunSummary } from '../../live/RunSummary.tsx'
import { secondsBetween } from '../../live/run-summary.ts'
import { isRunOver, leadStepCounts, pauseReasonText, statusLabel, usd } from './orch-model.ts'

export function RunStatus({
  run,
  badge = true,
}: {
  run: OrchestrationDetail
  /** The room panel already shows the badge in its sticky header. */
  badge?: boolean
}) {
  const counts = leadStepCounts(run.stepsList)
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
        Lead turn <LiveCount value={run.leadTurnsUsed} />
        {run.untilStopped ? ' (until you stop it)' : ` of ${run.maxLeadTurns}`},{' '}
        <LiveCount value={counts.succeeded} /> of {counts.total} steps done
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
