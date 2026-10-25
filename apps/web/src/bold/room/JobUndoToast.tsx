import { dismissJobUndo, undoJobDelete, useJobUndo } from './job-undo.ts'

/** The delete undo lives in the shell, so leaving the room does not take the toast with it. */
export function JobUndoToast() {
  const undo = useJobUndo()
  if (!undo.job && !undo.notice && !undo.error) return null
  return (
    <div className="chat-toasts bold-job-toasts" role="status" aria-live="polite">
      <div className="chat-toast bold-job-undo" data-protected="flex">
        {undo.job && (
          <span>
            Job deleted ·{' '}
            <button
              type="button"
              className="chat-toast-undo"
              disabled={undo.restoring}
              onClick={() => void undoJobDelete()}
            >
              {undo.restoring ? 'Restoring…' : 'Undo'}
            </button>
          </span>
        )}
        {undo.notice && <span>{undo.notice}</span>}
        {undo.error && <span role="alert">{undo.error}</span>}
        {!undo.job && (
          <button type="button" className="link" onClick={dismissJobUndo}>
            Dismiss
          </button>
        )}
        {undo.job && <small>Removes it from Score. Agents may still remember it.</small>}
      </div>
    </div>
  )
}
