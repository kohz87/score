import { ORCH_ACKNOWLEDGEMENT_TEXT, type RecipeSchedule } from '@score/contract'
import { useState } from 'react'
import { ApiError } from '../../data/api.ts'
import { RepeatsEditor } from './RepeatsEditor.tsx'
import {
  useRecipeSchedule,
  useRecipeScheduleActions,
  useScheduleBinding,
} from './recipe-schedule-queries.ts'
import { describeSchedule, whenText } from './schedule-words.ts'

const said = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Couldn’t do that. Try again.'

function LastRun({
  schedule,
  onRunNow,
  busy,
}: {
  schedule: RecipeSchedule
  onRunNow: () => void
  busy: boolean
}) {
  const last = schedule.lastRun
  if (!last || last.outcome === 'started') return null
  const when = whenText(last.at, schedule.timezone)
  return (
    <div className="bold-rs-note" data-protected="block" role="status">
      {last.outcome === 'missed' ? (
        <>
          <span>Missed {when}: Score wasn’t running.</span>{' '}
          <button type="button" className="btn sm" disabled={busy} onClick={onRunNow}>
            Run now
          </button>
        </>
      ) : (
        <span>
          The run of {when} didn’t start: {last.reason ?? 'Score couldn’t start it.'}
        </span>
      )}
    </div>
  )
}

/**
 * A recipe's Repeats card (decision 183, mock-up 28-tasks-recipe): doesn't repeat, or when it does, the chat each run
 * starts a job in, Pause/Resume, Change and Stop repeating (which asks first). The schedule is Score's own, so the card
 * says Score has to be running.
 */
export function RepeatsCard({ workflowId }: { workflowId: string }) {
  const { schedule, isPending, isError, refetch } = useRecipeSchedule(workflowId)
  const { save, runNow, stop } = useRecipeScheduleActions(workflowId)
  const binding = useScheduleBinding(workflowId)
  const [editing, setEditing] = useState(false)
  const [stopping, setStopping] = useState(false)
  const failure = save.error ?? runNow.error ?? stop.error

  return (
    <section className="bold-rs" aria-label="Repeats">
      <div className="bold-rs-head">
        <h2>Repeats</h2>
        {schedule && <span className="bold-rs-state">{schedule.enabled ? 'On' : 'Paused'}</span>}
      </div>
      {isError ? (
        <p role="alert" className="bold-error">
          Couldn’t load this recipe’s schedule.{' '}
          <button type="button" className="bold-link" onClick={() => void refetch()}>
            Try again
          </button>
        </p>
      ) : isPending ? (
        <p role="status" className="muted">
          Loading…
        </p>
      ) : editing ? (
        <RepeatsEditor
          workflowId={workflowId}
          schedule={schedule}
          onDone={() => setEditing(false)}
        />
      ) : schedule ? (
        <>
          <div className="bold-rs-when">
            <b>{describeSchedule(schedule.schedule)}</b>
            <span className="muted">
              {' '}
              ·{' '}
              {schedule.enabled
                ? schedule.nextRunAt
                  ? `next ${whenText(schedule.nextRunAt, schedule.timezone)}`
                  : 'next time not known'
                : 'paused'}
            </span>
          </div>
          <div className="bold-rs-chat">
            Each run starts one job in <b>{schedule.roomName}</b>.
          </div>
          <LastRun schedule={schedule} busy={runNow.isPending} onRunNow={() => runNow.mutate()} />
          {stopping ? (
            <div
              className="bold-rs-note"
              data-protected="block"
              role="group"
              aria-label="Stop repeating"
            >
              <span>
                Stop repeating this recipe? It stays a recipe; Score just won’t start it on a
                schedule.
              </span>
              <div className="bold-rs-actions">
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={stop.isPending}
                  onClick={() => stop.mutate(undefined, { onSuccess: () => setStopping(false) })}
                >
                  Yes, stop repeating
                </button>
                <button type="button" className="btn sm" onClick={() => setStopping(false)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <div className="bold-rs-actions">
              <button type="button" className="btn sm" onClick={() => setEditing(true)}>
                Change
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={save.isPending || (schedule.enabled && !binding.agentMap)}
                onClick={() =>
                  // Pausing keeps what the schedule is bound to; resuming goes through the editor, so the agents and
                  // the acknowledgement are seen again before it runs (decision 183).
                  schedule.enabled && binding.agentMap
                    ? save.mutate({
                        schedule: schedule.schedule,
                        timezone: schedule.timezone,
                        roomId: schedule.roomId,
                        enabled: false,
                        agentMap: binding.agentMap,
                        acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
                      })
                    : setEditing(true)
                }
              >
                {schedule.enabled ? 'Pause' : 'Resume'}
              </button>
              <button type="button" className="btn sm" onClick={() => setStopping(true)}>
                Stop repeating
              </button>
            </div>
          )}
          {failure && (
            <p role="alert" className="bold-error">
              {said(failure)}
            </p>
          )}
          <p className="small muted">
            Score starts these runs, so Score has to be running at the time. A run it missed shows
            here as missed, with Run now.
          </p>
        </>
      ) : (
        <>
          <p>Doesn’t repeat.</p>
          <div className="bold-rs-actions">
            <button type="button" className="btn sm primary" onClick={() => setEditing(true)}>
              Repeat it…
            </button>
          </div>
        </>
      )}
    </section>
  )
}
