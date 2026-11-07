import type { AgentSummary, TaskDetail, TaskPatchRequest } from '@score/contract'
import { useId, useState } from 'react'
import { agentDisplayName, canTalkTo } from './bold-agents.ts'
import { patchTask, useTaskRefresh } from './room/task-queries.ts'
import { failureText } from './bold-task-edit-model.ts'

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
