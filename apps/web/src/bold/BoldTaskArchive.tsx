import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../data/api.ts'
import { newId } from '../data/ids.ts'
import { taskAction, useTaskRefresh } from './room/task-queries.ts'
import { failureText } from './bold-task-edit-model.ts'

/** Archive takes a task off the board; it asks first, in place. Hermes keeps its history. */
export function ArchiveBox({ taskId, onArchived }: { taskId: string; onArchived: () => void }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef(newId())
  const refresh = useTaskRefresh()
  const confirmRef = useRef<HTMLDivElement>(null)
  const openRef = useRef<HTMLButtonElement>(null)
  const wasAsking = useRef(false)
  // The confirm takes focus when it appears; Escape or Keep it hands focus back to Archive…
  useEffect(() => {
    if (asking) confirmRef.current?.focus()
    else if (wasAsking.current) openRef.current?.focus()
    wasAsking.current = asking
  }, [asking])
  async function archive() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await taskAction(taskId, 'archive', undefined, key.current)
      refresh()
      onArchived()
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500)
        key.current = newId()
      setError(failureText(failure, 'archive this task'))
    } finally {
      setBusy(false)
    }
  }
  if (asking)
    return (
      <div
        ref={confirmRef}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || busy) return
          event.preventDefault()
          event.stopPropagation()
          setAsking(false)
        }}
        className="bold-tb-confirm"
        data-protected="flex"
        role="alertdialog"
        aria-label="Archive this task?"
      >
        <b>Archive this task?</b>
        <p>It leaves the board. Hermes keeps its history.</p>
        {error && (
          <p className="bold-request-error" role="alert">
            {error}
          </p>
        )}
        <span className="bold-tb-actions">
          <button
            type="button"
            className="btn sm bold-tb-danger"
            disabled={busy}
            onClick={() => void archive()}
          >
            {busy ? 'Archiving…' : 'Archive task'}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy}
            onClick={() => setAsking(false)}
          >
            Keep it
          </button>
        </span>
      </div>
    )
  return (
    <div className="bold-tb-archive">
      <p>Archive takes it off the board. Hermes keeps its history.</p>
      <button
        ref={openRef}
        type="button"
        className="btn sm bold-tb-danger-ghost"
        onClick={() => setAsking(true)}
      >
        Archive…
      </button>
    </div>
  )
}
