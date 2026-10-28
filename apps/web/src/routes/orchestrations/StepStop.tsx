import type { AttemptView, OrchestrationDetail, StepView } from '@score/contract'
import { useEffect, useState } from 'react'
import { describeOrchError, type Act } from './orchestration-queries.ts'

// 3.14: a step that shows no sign of life for a while is flagged, and any running or queued step can be stopped alone.
// The lead is told by the server and can give the work to someone else.

export const STUCK_AFTER_MS = 5 * 60_000

export type StopStepAction = Act<{ stepId: string; body: { orchestrationRevision: number } }>

const clockOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Minutes quiet when the step is running (admitted, its attempt sending or running) and quiet for over 5 minutes. */
export function quietMinutes(
  step: Pick<StepView, 'status' | 'lastActivityAt'>,
  attempt: Pick<AttemptView, 'state'> | undefined,
  now: number,
): number | null {
  if (step.status !== 'admitted' || !step.lastActivityAt) return null
  if (!attempt || (attempt.state !== 'send_started' && attempt.state !== 'running')) return null
  const quiet = now - new Date(step.lastActivityAt).getTime()
  return quiet > STUCK_AFTER_MS ? Math.floor(quiet / 60_000) : null
}

/** Re-renders every 30 s so a step turns "quiet" without a new event. Call it once per run and pass `now` down. */
/** The clock the Stop controls read, ticking every 30 s; `enabled: false` keeps it still (no Stop shown, no timer). */
export function useNow(enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}

export const canStopStep = (step: Pick<StepView, 'status'>): boolean =>
  step.status === 'admitted' || step.status === 'queued'

function StopConfirm({
  stepId,
  run,
  stop,
  compact,
}: {
  stepId: string
  run: Pick<OrchestrationDetail, 'revision'>
  stop: StopStepAction
  compact?: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  // This control's own request (review: the mutation's variables hold only the newest call, so two steps stopped at
  // once would lose track of the first): one at a time, and its error stays with it.
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const problem = failure ? (
    <span className="orch-error" role={compact ? 'alert' : undefined}>
      {describeOrchError(failure)}
    </span>
  ) : null
  if (!confirming && !sending)
    return (
      <>
        <button
          type="button"
          className={compact ? 'btn sm' : 'btn'}
          onClick={() => setConfirming(true)}
          aria-label={compact ? `Stop ${stepId}` : undefined}
        >
          {compact ? 'Stop' : 'Stop this step'}
        </button>
        {problem}
      </>
    )
  return (
    <span role="group" aria-label={`Confirm stopping ${stepId}`}>
      <span className="small">
        Stop {stepId}? The lead is told and can give the work to someone else.
      </span>{' '}
      <button
        type="button"
        className="btn sm"
        disabled={sending}
        onClick={() => {
          if (sending) return
          setSending(true)
          setFailure(null)
          stop.mutate(
            { stepId, body: { orchestrationRevision: run.revision } },
            {
              onError: setFailure,
              onSettled: () => {
                setSending(false)
                setConfirming(false)
              },
            },
          )
        }}
      >
        {sending ? 'Stopping…' : `Stop ${stepId}`}
      </button>{' '}
      <button
        type="button"
        className="btn sm"
        disabled={sending}
        onClick={() => setConfirming(false)}
      >
        Keep going
      </button>
      {problem}
    </span>
  )
}

/** The small "Stop" in a step row (a running or queued lead step). */
export function StepStopButton({
  step,
  run,
  stop,
  now,
}: {
  step: Pick<StepView, 'id' | 'status' | 'lastActivityAt'>
  run: Pick<OrchestrationDetail, 'revision' | 'status' | 'attempts'>
  stop: StopStepAction
  now: number
}) {
  if (!canStopStep(step) || run.status === 'stopping') return null
  // A quiet step already carries the stuck card with its own Stop.
  const attempt = run.attempts.filter((item) => item.stepId === step.id).at(-1)
  if (quietMinutes(step, attempt, now) !== null) return null
  return (
    <span className="orch-step-stop">
      <StopConfirm stepId={step.id} run={run} stop={stop} compact />
    </span>
  )
}

/** The card for a step that has been quiet for over 5 minutes. A decision surface, so it is protected. */
export function StuckStepCard({
  step,
  run,
  agentName,
  stop,
  now,
}: {
  step: StepView
  run: Pick<OrchestrationDetail, 'revision' | 'attempts'>
  agentName: string
  stop: StopStepAction
  now: number
}) {
  const attempt = run.attempts.filter((item) => item.stepId === step.id).at(-1)
  const minutes = quietMinutes(step, attempt, now)
  if (minutes === null || !step.lastActivityAt) return null
  return (
    <div className="orch-stuck" data-protected="block" role="alert">
      <p>
        {agentName} (step {step.id}) has been quiet for {minutes} min — last sign of life{' '}
        {clockOf(step.lastActivityAt)}. The model may be stuck or retrying.
      </p>
      <StopConfirm stepId={step.id} run={run} stop={stop} />
    </div>
  )
}
