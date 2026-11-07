import { JobSchema, type Job } from '@score/contract'
import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { jobLifecycleError } from './job-lifecycle-error.ts'

export function RenameJobDialog({
  job,
  onClose,
  onRenamed,
}: {
  job: Job
  onClose: () => void
  onRenamed: (job: Job) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState(job.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef(newId())
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const valid = title.trim().length >= 1 && title.trim().length <= 200
  async function rename() {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const renamed = JobSchema.parse(
        await apiFetch(`jobs/${encodeURIComponent(job.id)}`, {
          method: 'PATCH',
          headers: { 'Idempotency-Key': key.current },
          body: JSON.stringify({ title: title.trim() }),
        }),
      )
      onRenamed(renamed)
    } catch (failure) {
      key.current = newId()
      setError(jobLifecycleError(failure, 'rename').text)
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="chat-rewind-dialog bold-job-rename-dialog"
      data-protected="any"
      aria-labelledby="rename-job-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="rename-job-title">Rename job</h2>
      <label className="chat-delete-confirm">
        <span>Name</span>
        <input
          value={title}
          autoFocus
          autoComplete="off"
          maxLength={200}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void rename()
            }
          }}
        />
      </label>
      {error && (
        <p className="chat-rewind-warning" role="alert">
          {error}
        </p>
      )}
      <div className="chat-rewind-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="chat-rewind-primary"
          disabled={!valid || busy}
          onClick={() => void rename()}
        >
          {busy ? 'Renaming…' : 'Rename'}
        </button>
      </div>
    </dialog>
  )
}

export function DeleteJobDialog({
  job,
  onClose,
  onDeleted,
  onStop,
}: {
  job: Job
  onClose: () => void
  onDeleted: () => void
  onStop: (job: Job) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stillWorking, setStillWorking] = useState(false)
  const key = useRef(newId())
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const matches = typed === job.title
  async function remove() {
    if (!matches || busy) return
    setBusy(true)
    setError(null)
    setStillWorking(false)
    try {
      await apiFetch(`jobs/${encodeURIComponent(job.id)}`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': key.current },
      })
      onDeleted()
    } catch (failure) {
      key.current = newId()
      const problem = jobLifecycleError(failure, 'delete')
      setError(problem.text)
      setStillWorking(problem.stillWorking)
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="chat-rewind-dialog bold-job-delete-dialog"
      data-protected="any"
      aria-labelledby="delete-job-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="delete-job-title">Delete “{job.title}”?</h2>
      <ul className="chat-rewind-list">
        <li>Its messages and thread are removed from Score. Results saved to the Library stay.</li>
        <li>You can undo this for about 10 seconds.</li>
      </ul>
      <label className="chat-delete-confirm">
        <span>
          Type <strong>{job.title}</strong> to confirm
        </span>
        <input
          value={typed}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void remove()
            }
          }}
        />
      </label>
      {error && (
        <p className="chat-rewind-warning" role="alert">
          {error}
        </p>
      )}
      {stillWorking && (
        <button type="button" className="btn sm" disabled={busy} onClick={() => onStop(job)}>
          Stop
        </button>
      )}
      <div className="chat-rewind-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="chat-rewind-primary"
          disabled={!matches || busy}
          onClick={() => void remove()}
        >
          {busy ? 'Deleting…' : 'Delete job'}
        </button>
      </div>
    </dialog>
  )
}
