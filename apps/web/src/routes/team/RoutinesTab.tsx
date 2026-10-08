import { useRef, useState, type FormEvent } from 'react'
import type { RoutineSummary } from '@score/contract'
import { ApiError } from '../../data/api.ts'
import { useRoutineActions, useRoutines, type NewRoutine } from './routine-queries.ts'

function failure(error: unknown, action: string): string {
  if (error instanceof ApiError && error.code === 'not_paired')
    return `Pair this browser using the link in the server terminal to ${action}.`
  return `Could not ${action}. Please try again.`
}

function lastRun(routine: RoutineSummary): string {
  if (!routine.lastRunAt) return 'Not run yet'
  return `Last run ${new Date(routine.lastRunAt).toLocaleString()}`
}

export function RoutinesTab({
  agentId,
  agentName,
  startCreating,
}: {
  agentId: string
  agentName: string
  startCreating: boolean
}) {
  const routines = useRoutines(agentId)
  const { create, toggle, run, remove } = useRoutineActions(agentId)
  const [creating, setCreating] = useState(startCreating)
  const [draft, setDraft] = useState<NewRoutine>({ title: '', schedule: '', prompt: '' })
  const [confirming, setConfirming] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  // One key per distinct submission, so a retry after a lost response cannot create a second job.
  const attempt = useRef<{ body: string; key: string } | null>(null)
  const titleInput = useRef<HTMLInputElement>(null)

  function submit(event: FormEvent) {
    event.preventDefault()
    const routine = {
      title: draft.title.trim(),
      schedule: draft.schedule.trim(),
      prompt: draft.prompt.trim(),
    }
    const body = JSON.stringify(routine)
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() }
    create.mutate(
      { routine, key: attempt.current.key },
      {
        onSuccess: () => {
          attempt.current = null
          setDraft({ title: '', schedule: '', prompt: '' })
          setCreating(false)
          setNotice(`Created routine “${routine.title}”.`)
        },
      },
    )
  }
  const busy = toggle.isPending || run.isPending || remove.isPending
  const items = routines.data ?? []

  return (
    <section className="team-card" aria-labelledby="team-routines-heading">
      <div className="team-card-heading">
        <h2 id="team-routines-heading">Routines</h2>
        {!creating && (
          <button
            type="button"
            className="team-text-action"
            onClick={() => {
              create.reset()
              setCreating(true)
            }}
          >
            New routine
          </button>
        )}
      </div>
      {creating && (
        <form
          className="team-routine-form"
          aria-label="New routine"
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setCreating(false)
          }}
        >
          <label>
            Title
            <input
              ref={titleInput}
              required
              maxLength={200}
              autoFocus
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </label>
          <label>
            Schedule
            <input
              required
              maxLength={200}
              placeholder="every 2h, 30m or 0 9 * * *"
              value={draft.schedule}
              onChange={(event) => setDraft({ ...draft, schedule: event.target.value })}
            />
          </label>
          <label>
            Prompt
            <textarea
              required
              rows={4}
              maxLength={32000}
              placeholder={`What should ${agentName} do each time?`}
              value={draft.prompt}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </label>
          {create.isError && <p role="alert">{failure(create.error, 'create the routine')}</p>}
          <div className="team-style-actions">
            <button type="submit" className="team-primary" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create routine'}
            </button>
            <button type="button" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <p className="team-muted" role="status">
        {notice}
      </p>
      {routines.isPending && <p role="status">Loading routines…</p>}
      {routines.isError && (
        <p role="alert">
          Could not load routines.{' '}
          <button onClick={() => void routines.refetch()}>Try again</button>
        </p>
      )}
      {routines.isSuccess && !items.length && (
        <p className="team-muted-strong">No routines configured.</p>
      )}
      {(toggle.isError || run.isError || remove.isError) && (
        <p role="alert">
          {failure(toggle.error ?? run.error ?? remove.error, 'change the routine')}
        </p>
      )}
      <ul className="team-routine-list">
        {items.map((routine) => (
          <li className="team-routine team-routine-row" key={routine.id}>
            <span className="team-routine-schedule">{routine.schedule}</span>
            <div className="team-routine-body">
              <strong>
                {routine.title}
                {!routine.enabled && ' · Paused'}
              </strong>
              <p className="team-muted-strong">{routine.description}</p>
              <p className="team-muted">{lastRun(routine)}</p>
            </div>
            <div className="team-routine-actions">
              <button
                type="button"
                disabled={busy}
                aria-label={`${routine.enabled ? 'Pause' : 'Resume'} ${routine.title}`}
                onClick={() => {
                  setNotice('')
                  toggle.mutate({ id: routine.id, enabled: !routine.enabled })
                }}
              >
                {routine.enabled ? 'Pause' : 'Resume'}
              </button>
              <button
                type="button"
                disabled={busy}
                aria-label={`Run ${routine.title} now`}
                onClick={() =>
                  run.mutate(routine.id, {
                    onSuccess: () => setNotice(`“${routine.title}” will run on the next tick.`),
                  })
                }
              >
                Run now
              </button>
              {confirming === routine.id ? (
                <button
                  type="button"
                  className="team-danger"
                  disabled={busy}
                  autoFocus
                  aria-label={`Confirm deleting ${routine.title}`}
                  onBlur={() => setConfirming(null)}
                  onClick={() =>
                    remove.mutate(routine.id, {
                      onSuccess: () => {
                        setConfirming(null)
                        setNotice(`Deleted routine “${routine.title}”.`)
                      },
                    })
                  }
                >
                  Confirm delete
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Delete ${routine.title}`}
                  onClick={() => setConfirming(routine.id)}
                >
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
