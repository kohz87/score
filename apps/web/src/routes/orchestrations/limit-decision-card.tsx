import type { NeedsYou } from '@score/contract'
import { useState } from 'react'
import { Arrival } from '../../motion/Arrival.tsx'
import type { RunCoding } from './CodingCards.tsx'
import { ErrorLine, sourceName } from './decision-parts.tsx'
import { needsYouText, usd } from './orch-model.ts'
import type { DecisionActions } from './orchestration-queries.ts'
import type { LimitsRun } from './run-decision-types.ts'

export function LimitsCard({
  run,
  coding,
  reason,
  actions,
}: {
  run: LimitsRun
  /** The run's current coding authorisation; absent for a run without coding agents. */
  coding?: RunCoding | undefined
  reason: Extract<NeedsYou, { kind: 'budget' }>['reason']
  actions: Pick<DecisionActions, 'limits'>
}) {
  const [budget, setBudget] = useState('')
  const [deadline, setDeadline] = useState('')
  // 8.6: blank leaves the floor as it is; a number from 0 to 50 sets this run's floor for every coding agent.
  const [floor, setFloor] = useState('')
  const floorValue = Number(floor)
  const floorGiven = floor.trim() !== ''
  const floorValid =
    !floorGiven || (Number.isInteger(floorValue) && floorValue >= 0 && floorValue <= 50)
  const apply = () => {
    const raised = Number(budget)
    actions.limits.mutate({
      orchestrationRevision: run.revision,
      ...(budget !== '' && raised > 0 ? { budgetUsd: raised } : {}),
      ...(deadline !== '' ? { deadlineAt: new Date(deadline).toISOString() } : {}),
      ...(floorGiven && floorValid ? { quotaFloorPercent: floorValue } : {}),
    })
  }
  return (
    <Arrival
      arrivalId={`limits-${reason}`}
      data-protected="block"
      className="orch-decision"
      aria-label="Budget or deadline"
    >
      <h3>{needsYouText({ kind: 'budget', reason })}</h3>
      <p>
        Budget {run.budget.limitUsd === null ? 'not set' : usd(run.budget.limitUsd)}; settled{' '}
        {usd(run.budget.settledUsd)}, provisional {usd(run.budget.provisionalUsd)}, reserved{' '}
        {usd(run.budget.reservedUsd)}
        {run.budget.unknownSpend ? ', some spend unknown' : ''}.
      </p>
      <div className="orch-row">
        <label className="orch-field">
          <span>New budget (USD)</span>
          <input
            inputMode="decimal"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
        </label>
        <label className="orch-field">
          <span>New deadline</span>
          <input
            type="datetime-local"
            value={deadline}
            onChange={(event) => setDeadline(event.target.value)}
          />
        </label>
        {coding && (
          <label className="orch-field">
            <span>
              Quota floor (%){' '}
              {coding.quotaFloorPercent === null || coding.quotaFloorPercent === undefined
                ? '(each agent’s own now)'
                : `(${coding.quotaFloorPercent}% now)`}
            </span>
            <input
              type="number"
              min={0}
              max={50}
              inputMode="numeric"
              value={floor}
              aria-invalid={!floorValid}
              onChange={(event) => setFloor(event.target.value)}
            />
          </label>
        )}
      </div>
      <div className="orch-actions">
        <button
          type="button"
          className="orch-primary"
          disabled={
            actions.limits.isPending ||
            !floorValid ||
            (budget === '' && deadline === '' && !floorGiven)
          }
          onClick={apply}
        >
          Apply and continue
        </button>
        {reason === 'unknown_spend' && (
          <button
            type="button"
            disabled={actions.limits.isPending}
            onClick={() =>
              actions.limits.mutate({
                orchestrationRevision: run.revision,
                acceptUnknownSpend: true,
              })
            }
          >
            Continue although spend is unknown
          </button>
        )}
        {reason === 'unknown_spend' &&
          coding &&
          coding.unknownSpend !== 'continue' &&
          (['claude-code', 'codex'] as const)
            .filter((source) => coding.workers.some((worker) => worker.runtime === source))
            .filter((source) => !coding.acceptedUnknownCost.includes(source))
            .map((source) => (
              <button
                key={source}
                type="button"
                disabled={actions.limits.isPending}
                onClick={() =>
                  actions.limits.mutate({
                    orchestrationRevision: run.revision,
                    acceptUnknownCost: { add: [source] },
                  })
                }
              >
                Continue although {sourceName(source)} cost is unknown
              </button>
            ))}
      </div>
      <ErrorLine error={actions.limits.error} />
    </Arrival>
  )
}
