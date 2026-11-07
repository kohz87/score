import type { AgentSummary, Room, TaskDetail } from '@score/contract'
import { useId, useRef, useState } from 'react'
import { ApiError } from '../data/api.ts'
import { newId } from '../data/ids.ts'
import { agentDisplayName } from './bold-agents.ts'
import { createTask, useTaskRefresh } from './room/task-queries.ts'
import { failureText, workers } from './bold-task-edit-model.ts'
import { useDialogFocus } from './use-task-dialog-focus.ts'

// 3.27.0 (DECISIONS 162): the Tasks page makes, edits, moves and archives Hermes tasks again.
// Mock-ups: docs/design/bold/mockups/20-tasks*.dc.html.

export { ArchiveBox } from './BoldTaskArchive.tsx'
export { TaskEditForm } from './BoldTaskEditForm.tsx'
export { TaskMoves } from './BoldTaskMoves.tsx'

export function NewTaskDialog({
  agents,
  rooms,
  onClose,
  onCreated,
}: {
  agents: AgentSummary[]
  rooms: Room[]
  onClose: () => void
  onCreated: (task: TaskDetail & { startFailed?: boolean }) => void
}) {
  const ref = useDialogFocus(onClose)
  const ids = { title: useId(), body: useId(), who: useId(), room: useId() }
  const choices = workers(agents)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [assignee, setAssignee] = useState(choices[0]?.id ?? '')
  const [roomId, setRoomId] = useState('')
  const [start, setStart] = useState<'now' | 'later'>('now')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef(newId())
  const refresh = useTaskRefresh()
  const who = choices.find((agent) => agent.id === assignee)

  async function submit() {
    if (busy) return
    if (!title.trim()) {
      setError('Say what needs doing first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const made = await createTask(
        {
          title: title.trim(),
          ...(body.trim() ? { body: body.trim() } : {}),
          ...(assignee ? { assignee } : {}),
          ...(roomId ? { roomId } : {}),
          start,
        },
        key.current,
      )
      key.current = newId()
      refresh()
      onCreated(made)
    } catch (failure) {
      // A rejected request is not retried as it was: its key is renewed. A network failure keeps the key.
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500)
        key.current = newId()
      setError(failureText(failure, 'create this task'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={ref}
      className="bold-tb-dialog"
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      aria-label="New task"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="bold-tb-dialog-head">
          <h2>New task</h2>
          <button type="button" className="bold-tb-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <label htmlFor={ids.title} className="bold-tb-label">
          What needs doing
        </label>
        <input
          id={ids.title}
          className="bold-tb-field bold-tb-field--title"
          value={title}
          maxLength={1000}
          placeholder="A short title"
          required
          onChange={(event) => setTitle(event.target.value)}
        />
        <label htmlFor={ids.body} className="bold-tb-label">
          Details (optional)
        </label>
        <textarea
          id={ids.body}
          className="bold-tb-field bold-tb-field--area"
          rows={4}
          value={body}
          maxLength={32000}
          placeholder="What done looks like, links, constraints"
          onChange={(event) => setBody(event.target.value)}
        />
        <div className="bold-tb-two">
          <div>
            <label htmlFor={ids.who} className="bold-tb-label">
              Who does it
            </label>
            <select
              id={ids.who}
              className="bold-tb-field"
              value={assignee}
              disabled={choices.length === 0}
              onChange={(event) => setAssignee(event.target.value)}
            >
              {choices.length === 0 && <option value="">No agent is ready</option>}
              {choices.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agentDisplayName(agent)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={ids.room} className="bold-tb-label">
              In which chat
            </label>
            <select
              id={ids.room}
              className="bold-tb-field"
              value={roomId}
              onChange={(event) => setRoomId(event.target.value)}
            >
              <option value="">No chat</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset className="bold-tb-start">
          <legend className="bold-tb-label">Start</legend>
          <label data-on={start === 'now'}>
            <input
              type="radio"
              name="start"
              checked={start === 'now'}
              onChange={() => setStart('now')}
            />{' '}
            Now
          </label>
          <label data-on={start === 'later'}>
            <input
              type="radio"
              name="start"
              checked={start === 'later'}
              onChange={() => setStart('later')}
            />{' '}
            Plan it for later
          </label>
        </fieldset>
        <p className="bold-tb-hint">
          The same as typing <code>/assign @{who?.id ?? 'agent'} …</code> in a chat.
        </p>
        {error && (
          <p className="bold-request-error" role="alert">
            {error}
          </p>
        )}
        <div className="bold-tb-dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
