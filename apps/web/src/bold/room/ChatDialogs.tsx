import type { Job } from '@score/contract'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, ApiError } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { jobLifecycleError } from './job-lifecycle-error.ts'

/** Deleting a one-to-one chat: a plain confirm (no typing), undoable for about 10 seconds like any job. */
export function DeleteChatDialog({
  chat,
  agentName,
  onClose,
  onDeleted,
}: {
  chat: Job
  agentName: string
  onClose: () => void
  onDeleted: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef(newId())
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  async function remove() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`jobs/${encodeURIComponent(chat.id)}`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': key.current },
      })
      onDeleted()
    } catch (failure) {
      key.current = newId()
      setError(jobLifecycleError(failure, 'delete').text.replace('this job', 'this chat'))
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
      aria-labelledby="delete-chat-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="delete-chat-title">Delete this chat with {agentName}?</h2>
      <ul className="chat-rewind-list">
        <li>
          Its messages are removed from Score. {agentName}’s own sessions in Hermes are not touched,
          so it may still remember the conversation.
        </li>
        <li>You can undo this for about 10 seconds.</li>
      </ul>
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
          disabled={busy}
          onClick={() => void remove()}
        >
          {busy ? 'Deleting…' : 'Delete chat'}
        </button>
      </div>
    </dialog>
  )
}

/** Clearing a one-to-one's main chat: every message goes from Score; the agent's other chats stay. */
export function ClearChatDialog({
  roomId,
  agentName,
  onClose,
  onCleared,
}: {
  roomId: string
  agentName: string
  onClose: () => void
  onCleared: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cleared, setCleared] = useState<number | null>(null)
  const key = useRef(newId())
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  async function clear() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = (await apiFetch(`rooms/${encodeURIComponent(roomId)}/clear`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key.current },
        body: '{}',
      })) as { cleared?: number }
      setCleared(Number(result.cleared ?? 0))
      onCleared()
    } catch (failure) {
      key.current = newId()
      setError(
        failure instanceof ApiError && failure.status === 409
          ? failure.message
          : 'Couldn’t clear this chat. Try again.',
      )
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
      aria-labelledby="clear-chat-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="clear-chat-title">Clear this chat with {agentName}?</h2>
      {cleared === null ? (
        <p>
          Removes every message of this chat from Score. {agentName} may still remember them. Other
          chats with {agentName} stay.
        </p>
      ) : (
        <p role="status">
          Cleared {cleared} {cleared === 1 ? 'message' : 'messages'}.
        </p>
      )}
      {error && (
        <p className="chat-rewind-warning" role="alert">
          {error}
        </p>
      )}
      <div className="chat-rewind-actions">
        {cleared === null ? (
          <>
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="chat-rewind-primary"
              disabled={busy}
              onClick={() => void clear()}
            >
              {busy ? 'Clearing…' : 'Clear chat'}
            </button>
          </>
        ) : (
          <button type="button" className="chat-rewind-primary" onClick={onClose}>
            Done
          </button>
        )}
      </div>
    </dialog>
  )
}
