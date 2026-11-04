import { JobSchema, type Job } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError, apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { decisionError } from './RoomRequests.tsx'
import { changeCachedJob } from './room-queries.ts'

/**
 * Stop job (3.28.0): asks first, then `POST /api/jobs/:id/end`, which stops the run and the work and closes the job.
 * Shared by the job bar and Info's "This job". Returns the button and the confirm separately so each surface can lay
 * them out (the bar puts the confirm on its own row). The confirm is a decision, so it is protected.
 */
export function useStopJob(
  job: Job,
  {
    onConfirming,
    onStopped,
  }: { onConfirming?: (confirming: boolean) => void; onStopped?: (job: Job | null) => void } = {},
): { button: ReactNode; confirm: ReactNode; confirming: boolean } {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stopped, setStopped] = useState(false)
  const stopButton = useRef<HTMLButtonElement>(null)
  const keepGoing = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirming) keepGoing.current?.focus()
    onConfirming?.(confirming)
  }, [confirming, onConfirming])
  function cancel() {
    setConfirming(false)
    stopButton.current?.focus()
  }
  async function stop() {
    setStopping(true)
    setError(null)
    try {
      const body = await apiFetch(`jobs/${encodeURIComponent(job.id)}/end`, {
        method: 'POST',
        headers: { 'Idempotency-Key': newId() },
        body: '{}',
      })
      const closed = JobSchema.safeParse(body)
      // The stream's job.upserted follows; this makes the tab the person acted on change at once.
      if (closed.success) changeCachedJob(queryClient, closed.data, 'upsert')
      setConfirming(false)
      setStopped(true)
      onStopped?.(closed.success ? closed.data : null)
    } catch (failure) {
      setError(
        failure instanceof ApiError && [401, 403, 409].includes(failure.status)
          ? decisionError(failure)
          : 'Couldn’t stop this job. Try again.',
      )
    } finally {
      setStopping(false)
    }
  }
  const finished = job.state === 'done' || job.state === 'closed'
  const button = (
    <button
      type="button"
      ref={stopButton}
      className="btn sm bold-thread-stop"
      disabled={finished || stopping}
      onClick={() => setConfirming(true)}
    >
      Stop job
    </button>
  )
  const confirm = confirming ? (
    <div
      className="bold-thread-stop-confirm"
      data-protected="block"
      role="alertdialog"
      aria-label={`Stop ${job.title}?`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        cancel()
      }}
    >
      <b>Stop “{job.title}”?</b>
      <span>Running steps stop and the job closes. What it made stays in Past jobs.</span>
      {error && (
        <span className="bold-thread-error" role="alert">
          {error}
        </span>
      )}
      <div className="bold-thread-confirm-actions">
        <button ref={keepGoing} type="button" className="btn sm ghost" onClick={cancel}>
          Keep going
        </button>
        <button type="button" className="btn sm" disabled={stopping} onClick={() => void stop()}>
          {stopping ? 'Stopping…' : 'Stop job'}
        </button>
      </div>
    </div>
  ) : error ? (
    <p className="bold-thread-error" role="alert">
      {error}
    </p>
  ) : stopped ? (
    <p className="bold-thread-status-line" role="status">
      Stopped. It moves to Past jobs.
    </p>
  ) : null
  return { button, confirm, confirming }
}
