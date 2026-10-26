import { useState } from 'react'
import type { AgentDetail } from '@score/contract'
import { Link } from 'react-router'
import { useRoutineActions, useRoutines } from '../../routes/team/routine-queries.ts'
import { boldStartJobLink } from '../bold-links.ts'
import { RemoveConfirm } from '../RemoveConfirm.tsx'
import { Fail, Loading, MoreCard, problem } from './MoreCard.tsx'

export function RoutinesCard({ agent }: { agent: AgentDetail }) {
  const routines = useRoutines(agent.id)
  const { toggle, run, remove } = useRoutineActions(agent.id)
  const [notice, setNotice] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const items = routines.data ?? []
  const busy = toggle.isPending || run.isPending || remove.isPending
  return (
    <MoreCard id="agent-routines" title="Repeating jobs">
      {routines.isPending && <Loading what="repeating jobs" />}
      {routines.isError && (
        <Fail>
          Couldn’t load repeating jobs.{' '}
          <button type="button" className="link" onClick={() => void routines.refetch()}>
            Try again
          </button>
        </Fail>
      )}
      {routines.isSuccess && !items.length && <p className="small muted">None yet.</p>}
      {(toggle.isError || run.isError) && (
        <Fail>
          {problem(toggle.error ?? run.error, 'Couldn’t change the repeating job. Try again.')}
        </Fail>
      )}
      {items.map((routine) => (
        <div className="listrow wrap" key={routine.id}>
          <span className="grow small">
            {routine.title} · {routine.schedule}
            {!routine.enabled && ' · Paused'}
          </span>
          <button
            type="button"
            className="act"
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
            className="act"
            disabled={busy}
            aria-label={`Run ${routine.title} now`}
            onClick={() =>
              run.mutate(routine.id, {
                onSuccess: () => setNotice(`“${routine.title}” will run shortly.`),
              })
            }
          >
            Run now
          </button>
          <button
            type="button"
            className="act"
            disabled={busy}
            aria-label={`Delete ${routine.title}`}
            aria-expanded={confirming === routine.id}
            onClick={() => {
              remove.reset()
              setConfirming(confirming === routine.id ? null : routine.id)
            }}
          >
            Delete
          </button>
          {confirming === routine.id && (
            <RemoveConfirm
              what={routine.title}
              text={`Deletes the repeating job “${routine.title}”. Work it already started is not stopped.`}
              pending={remove.isPending}
              error={remove.error}
              onCancel={() => setConfirming(null)}
              onRemove={() =>
                remove.mutate(routine.id, {
                  onSuccess: () => {
                    setConfirming(null)
                    setNotice(`Deleted “${routine.title}”.`)
                  },
                })
              }
            />
          )}
        </div>
      ))}
      <p className="small muted" role="status">
        {notice}
      </p>
      <Link className="link bold-mc-start" to={boldStartJobLink()}>
        Start a repeating job
      </Link>
    </MoreCard>
  )
}
