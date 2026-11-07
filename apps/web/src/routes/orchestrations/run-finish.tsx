import type { OrchestrationDetail } from '@score/contract'
import { time } from './run-panel-format.ts'
import { AttemptLine } from './step-card.tsx'

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
