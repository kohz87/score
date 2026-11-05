import type { AgentSummary, Room, TaskDetail, TaskPatchRequest } from '@score/contract'
import { useEffect, useId, useRef, useState } from 'react'
import { ApiError } from '../data/api.ts'
import { newId } from '../data/ids.ts'
import { agentDisplayName, canTalkTo } from './bold-agents.ts'
import { pairingProblem } from './bold-errors.ts'
import {
  createTask,
  patchTask,
  taskAction,
  useTaskRefresh,
  type TaskActionName,
} from './room/task-queries.ts'

// 3.27.0 (DECISIONS 162): the Tasks page makes, edits, moves and archives Hermes tasks again.
// Mock-ups: docs/design/bold/mockups/20-tasks*.dc.html.

function failureText(failure: unknown, verb: string): string {
  const pairing = pairingProblem(failure)
  if (pairing) return pairing
  if (failure instanceof ApiError && [400, 409].includes(failure.status)) return failure.message
  return `Couldn’t ${verb}. Try again.`
}

/** A native modal dialog (inert page behind, focus kept inside); Escape closes it and focus goes back to what opened it. */
function useDialogFocus(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const dialog = ref.current
    // Without showModal (old engines, jsdom) the dialog is rendered `open` and only the Escape handler applies.
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal()
    ref.current?.querySelector<HTMLElement>('input, textarea, select')?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      close.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      opener?.focus?.()
    }
  }, [])
  return ref
}

/** Who can take work: ready agents (not setting up, leaving or removed). */
export const workers = (agents: AgentSummary[]) => agents.filter(canTalkTo)

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

/** The panel's edit form: title, description and who does it; only what changed is sent. */
export function TaskEditForm({
  detail,
  agents,
  onDone,
}: {
  detail: TaskDetail
  agents: AgentSummary[]
  onDone: () => void
}) {
  const ids = { title: useId(), body: useId(), who: useId() }
  const [title, setTitle] = useState(detail.title)
  const [body, setBody] = useState(detail.body)
  const [assignee, setAssignee] = useState(detail.assignee ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useTaskRefresh()
  // The current assignee stays choosable even if it can't take new work.
  const choices = agents.filter((agent) => canTalkTo(agent) || agent.id === detail.assignee)

  async function save() {
    if (busy) return
    const patch: TaskPatchRequest = {}
    if (title.trim() !== detail.title) patch.title = title.trim()
    if (body !== detail.body) patch.body = body
    if (assignee && assignee !== (detail.assignee ?? '')) patch.assignee = assignee
    if (!title.trim()) {
      setError('A task needs a title.')
      return
    }
    if (Object.keys(patch).length === 0) {
      onDone()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await patchTask(detail.id, patch)
      refresh()
      onDone()
    } catch (failure) {
      setError(failureText(failure, 'save these changes'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="bold-tb-edit"
      aria-label="Edit task"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <label htmlFor={ids.title} className="bold-tb-label">
        Title
      </label>
      <input
        id={ids.title}
        className="bold-tb-field bold-tb-field--title"
        value={title}
        maxLength={1000}
        onChange={(event) => setTitle(event.target.value)}
      />
      <label htmlFor={ids.body} className="bold-tb-label">
        Description
      </label>
      <textarea
        id={ids.body}
        className="bold-tb-field bold-tb-field--area"
        rows={5}
        value={body}
        maxLength={32000}
        onChange={(event) => setBody(event.target.value)}
      />
      <label htmlFor={ids.who} className="bold-tb-label">
        Doing it
      </label>
      <select
        id={ids.who}
        className="bold-tb-field"
        value={assignee}
        onChange={(event) => setAssignee(event.target.value)}
      >
        {!detail.assignee && <option value="">Nobody yet</option>}
        {choices.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agentDisplayName(agent)}
          </option>
        ))}
      </select>
      {error && (
        <p className="bold-request-error" role="alert">
          {error}
        </p>
      )}
      <span className="bold-tb-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </span>
    </form>
  )
}

type Move = { action: TaskActionName; label: string }
const MOVES: Record<string, Move[]> = {
  planned: [
    { action: 'start', label: 'Start' },
    { action: 'block', label: 'Block' },
  ],
  working: [
    { action: 'request_review', label: 'Ask for review' },
    { action: 'block', label: 'Block' },
    { action: 'complete', label: 'Mark done' },
  ],
  in_review: [
    { action: 'complete', label: 'Mark done' },
    { action: 'block', label: 'Block' },
  ],
}

/** The moves that make sense for the task's column. A blocked task has Unblock instead; a done one has none. */
export function TaskMoves({ taskId, column }: { taskId: string; column: string }) {
  const moves = MOVES[column] ?? []
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const keys = useRef<Record<string, string>>({})
  const refresh = useTaskRefresh()
  if (moves.length === 0) return null
  async function run(move: Move) {
    if (busy) return
    setBusy(move.action)
    setError(null)
    const key = (keys.current[move.action] ??= newId())
    try {
      await taskAction(taskId, move.action, undefined, key)
      delete keys.current[move.action]
      refresh()
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500)
        delete keys.current[move.action]
      setError(failureText(failure, `${move.label.toLowerCase()} this task`))
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className="bold-tb-section bold-tb-moves" aria-label="Move it">
      <h3>Move it</h3>
      <span className="bold-tb-actions">
        {moves.map((move) => (
          <button
            key={move.action}
            type="button"
            className="btn sm"
            disabled={busy !== null}
            onClick={() => void run(move)}
          >
            {busy === move.action ? 'Sending…' : move.label}
          </button>
        ))}
      </span>
      {error && (
        <span className="bold-request-error" role="alert">
          {error}
        </span>
      )}
    </section>
  )
}

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
