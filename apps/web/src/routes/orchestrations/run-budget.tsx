import type { OrchestrationDetail } from '@score/contract'
import type { RunCoding } from './CodingCards.tsx'
import { sourceName } from './decision-parts.tsx'
import { usd } from './orch-model.ts'

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
