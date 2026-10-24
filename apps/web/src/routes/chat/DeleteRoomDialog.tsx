import type { Room } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { deleteRoom, fetchDeletePlan } from './room-actions.ts'

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const BLOCKED: Record<'room_busy' | 'orchestration_owned' | 'direct', string> = {
  room_busy: 'An agent is working in this room. Stop it first, then delete the room.',
  orchestration_owned:
    'An orchestration or workflow run still owns this room. Stop the run, or wait until it finishes.',
  direct: 'A direct room is the agent’s home and can’t be deleted.',
}

/**
 * Deleting a room (PLAN 5.36): says what goes, offers the export first and asks for the room’s name. Only Score’s copy is
 * removed; the agents’ Hermes sessions stay as they are.
 */
export function DeleteRoomDialog({
  room,
  onDeleted,
  onClose,
}: {
  room: Room
  onDeleted: () => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const plan = useQuery({
    queryKey: ['chat', 'delete-plan', room.id],
    queryFn: () => fetchDeletePlan(room.id),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  })
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef(newId())
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const data = plan.data
  const matches = typed === room.name
  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await deleteRoom(room.id, typed, key.current)
      onDeleted()
    } catch (failure) {
      setBusy(false)
      key.current = newId()
      setError(
        failure instanceof ApiError && failure.status === 409
          ? failure.message
          : 'Couldn’t delete the room. Try again.',
      )
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="chat-rewind-dialog bold-room-delete-dialog"
      data-protected="any"
      aria-labelledby="delete-room-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="delete-room-title">Delete {room.name}?</h2>
      {plan.isPending && <p role="status">Checking what this removes…</p>}
      {plan.isError && (
        <p role="alert">Couldn’t check what this removes. Close this and try again.</p>
      )}
      {data && (
        <>
          <ul className="chat-rewind-list">
            <li>
              {plural(data.messages, 'message', 'messages')}
              {data.files > 0 ? `, ${plural(data.files, 'attached file', 'attached files')}` : ''}
              {data.runs > 0 ? `, ${plural(data.runs, 'run record', 'run records')}` : ''}
              {data.briefs > 0 ? ` and ${plural(data.briefs, 'Flow run', 'Flow runs')}` : ''} will
              be removed from Score for good.
            </li>
            <li>
              The agents’ Hermes sessions are <strong>not</strong> touched: they still remember this
              room. Reports and Watch history stay.
            </li>
            <li>
              <a href={`/api/rooms/${encodeURIComponent(room.id)}/export.md`} download>
                Export as Markdown
              </a>{' '}
              or{' '}
              <a href={`/api/rooms/${encodeURIComponent(room.id)}/export.json`} download>
                JSON
              </a>{' '}
              first if you may want it back. Archiving hides a room without deleting it.
            </li>
          </ul>
          {data.blocked && (
            <p className="chat-rewind-warning" role="alert">
              {BLOCKED[data.blocked]}
            </p>
          )}
          {!data.blocked && (
            <label className="chat-delete-confirm">
              <span>
                Type <strong>{room.name}</strong> to confirm
              </span>
              <input
                value={typed}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && matches && !busy) {
                    event.preventDefault()
                    void confirm()
                  }
                }}
              />
            </label>
          )}
        </>
      )}
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
          disabled={busy || !data || Boolean(data.blocked) || !matches}
          onClick={() => void confirm()}
        >
          {busy ? 'Deleting…' : 'Delete room'}
        </button>
      </div>
    </dialog>
  )
}
