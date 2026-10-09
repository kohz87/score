import { dismissDeleteFailure, undoDelete, usePendingDeletes } from './message-deletion.ts'

/** "Message deleted · Undo" while the undo window is open, and a note if the delete could not be sent. */
export function DeleteToast() {
  const { ids, failed } = usePendingDeletes()
  if (ids.size === 0 && !failed) return null
  return (
    <div className="chat-toasts" role="status" aria-live="polite">
      {[...ids].map((id) => (
        <div key={id} className="chat-toast">
          <span>
            Message deleted ·{' '}
            <button type="button" className="chat-toast-undo" onClick={() => undoDelete(id)}>
              Undo
            </button>
          </span>
          <small>Removes it from Score. Agents may still remember it.</small>
        </div>
      ))}
      {failed && (
        <div className="chat-toast" role="alert">
          <span>{failed}</span>
          <button type="button" className="chat-toast-undo" onClick={dismissDeleteFailure}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}
