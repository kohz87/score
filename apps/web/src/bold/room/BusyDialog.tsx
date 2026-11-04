import { JobRunningDetailsSchema, JobSchema } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { ApiError, apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { changeCachedJob } from './room-queries.ts'

/** What a person was starting when the chat turned out to have a job already; the busy dialog names it. */
export type BusyStart = {
  /** The job that is running (from the room's jobs, or from the 409's details). */
  running: { id: string; title: string }
  /** The chat, by name. */
  chatName: string
  /** "run “Write and review”", "a new run": what the person asked for. */
  starting: string
  /** A line to show when it opens ("Still stopping… try again in a moment." after a retry that was refused). */
  note?: string
}

/** The running job a `409 job_running` names, or null when the error is something else. */
export function jobRunningOf(error: unknown): { id: string; title: string } | null {
  if (!(error instanceof ApiError) || error.code !== 'job_running') return null
  const details = JobRunningDetailsSchema.safeParse(error.details)
  return details.success ? { id: details.data.jobId, title: details.data.title } : null
}

/**
 * Starting work in a chat that already has a job (3.28.0, mock-up 22 busy). One job per chat: stop the running one
 * and start this (which retries the start), start it in another chat, or cancel. It asks the person to decide, so it
 * is protected. A modal `<dialog>`: Escape is Cancel, Tab stays inside, and focus returns to what opened it.
 */
export function BusyDialog({
  busy,
  onStopAndStart,
  onAnotherChat,
  onCancel,
}: {
  busy: BusyStart
  /** Runs after the running job is stopped; throws the start's own error (a 409 job_running means "still stopping"). */
  onStopAndStart: () => Promise<void>
  onAnotherChat: () => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const [working, setWorking] = useState(false)
  const [note, setNote] = useState<string | null>(busy.note ?? null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const element = dialog.current
    if (element && typeof element.showModal === 'function' && !element.open) element.showModal()
    cancel.current?.focus()
    const from = opener.current
    return () => {
      if (typeof element?.close === 'function' && element.open) element.close()
      // The opener may be gone (a menu item that closed): the composer is where a person goes on from.
      const target =
        from?.isConnected && from !== document.body
          ? from
          : document.querySelector<HTMLElement>('.bold-room-composer textarea')
      target?.focus()
    }
  }, [])
  async function stopAndStart() {
    if (working) return
    setWorking(true)
    setNote(null)
    setError(null)
    try {
      const ended = await apiFetch(`jobs/${encodeURIComponent(busy.running.id)}/end`, {
        method: 'POST',
        headers: { 'Idempotency-Key': newId() },
        body: '{}',
      })
      const closed = JobSchema.safeParse(ended)
      if (closed.success) changeCachedJob(queryClient, closed.data, 'upsert')
      await onStopAndStart()
    } catch (failure) {
      if (jobRunningOf(failure)) setNote('Still stopping… try again in a moment.')
      else
        setError(
          failure instanceof ApiError && failure.message
            ? failure.message
            : 'Couldn’t stop the job. Try again.',
        )
    } finally {
      setWorking(false)
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    // Whatever dialog this sits in (Start a job traps Tab and closes on Escape) must not see these keys.
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!working) onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const controls = [
      ...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []),
    ]
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="bold-busy-dialog"
      data-protected="block"
      aria-labelledby={titleId}
      aria-modal="true"
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault()
        if (!working) onCancel()
      }}
    >
      <h2 id={titleId}>{busy.chatName} already has a job</h2>
      <p>
        “{busy.running.title}” is still running. A chat does one job at a time, so stop it first, or
        start this in another chat.
      </p>
      <div className="bold-busy-new">
        <b>New:</b> {busy.starting}
      </div>
      {note && (
        <p className="bold-busy-note" role="status">
          {note}
        </p>
      )}
      {error && (
        <p className="bold-busy-note" role="alert">
          {error}
        </p>
      )}
      <div className="bold-busy-actions">
        <button
          type="button"
          className="bold-busy-primary"
          disabled={working}
          onClick={() => void stopAndStart()}
        >
          {working ? 'Stopping…' : 'Stop the job and start this'}
        </button>
        <button
          type="button"
          className="bold-busy-ghost"
          disabled={working}
          onClick={onAnotherChat}
        >
          Start in another chat…
        </button>
        <button ref={cancel} type="button" className="bold-busy-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="bold-busy-foot">
        Stopping ends the running steps and keeps what the job made. It moves to Past jobs.
      </p>
    </dialog>
  )
}
