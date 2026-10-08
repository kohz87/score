import { useEffect, useRef, useState, type FormEvent } from 'react'
import { TaskDetailSchema, type AgentSummary, type Room, type TaskDetail } from '@score/contract'
import { ApiError, apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'

const newKey = newId

// POST /api/tasks (contract §7). The card itself arrives on the stream as `task.upserted`.
export function NewTaskDialog({
  agents,
  rooms,
  defaultRoom,
  close,
  created,
}: {
  agents: AgentSummary[]
  rooms: Room[]
  defaultRoom: string
  close: () => void
  created: (task: TaskDetail) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  // One key per distinct request: a retry of the same form replays, an edited form is a new request.
  const key = useRef(newKey())
  const [form, setForm] = useState({
    title: '',
    body: '',
    assignee: '',
    roomId: rooms.some((room) => room.id === defaultRoom) ? defaultRoom : '',
    steps: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    dialog.current?.showModal?.()
    // showModal focuses the first control (Close); the title is where typing starts.
    titleInput.current?.focus()
  }, [])
  function change(patch: Partial<typeof form>) {
    setForm((current) => ({ ...current, ...patch }))
    key.current = newKey()
    setError(null)
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const steps = form.steps
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    setBusy(true)
    setError(null)
    try {
      const task = TaskDetailSchema.parse(
        await apiFetch('tasks', {
          method: 'POST',
          headers: { 'Idempotency-Key': key.current },
          body: JSON.stringify({
            title: form.title.trim(),
            ...(form.body.trim() ? { body: form.body.trim() } : {}),
            ...(form.assignee ? { assignee: form.assignee } : {}),
            ...(form.roomId ? { roomId: form.roomId } : {}),
            ...(steps.length ? { steps } : {}),
          }),
        }),
      )
      created(task)
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not create the task. Please try again.',
      )
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="task-new-dialog"
      aria-labelledby="new-task-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="task-new-heading">
        <h2 id="new-task-title">New task</h2>
        <button type="button" className="task-filter" onClick={close}>
          Close
        </button>
      </div>
      <form className="task-new-form" onSubmit={(event) => void submit(event)}>
        <label>
          Title
          <input
            ref={titleInput}
            required
            maxLength={1000}
            value={form.title}
            onChange={(event) => change({ title: event.target.value })}
          />
        </label>
        <label>
          Details
          <textarea
            rows={4}
            maxLength={32000}
            value={form.body}
            onChange={(event) => change({ body: event.target.value })}
          />
        </label>
        <div className="task-new-row">
          <label>
            Assignee
            <select
              value={form.assignee}
              onChange={(event) => change({ assignee: event.target.value })}
            >
              <option value="">Unassigned</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Room
            <select
              value={form.roomId}
              onChange={(event) => change({ roomId: event.target.value })}
            >
              <option value="">No room</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Steps (optional, one per line)
          <textarea
            rows={3}
            value={form.steps}
            onChange={(event) => change({ steps: event.target.value })}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="task-drawer-primary" disabled={busy || !form.title.trim()}>
          {busy ? 'Creating…' : 'Create task'}
        </button>
      </form>
    </dialog>
  )
}
