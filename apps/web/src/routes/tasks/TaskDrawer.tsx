import { useState, type Ref } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import {
  ApprovalSchema,
  TaskDetailSchema,
  type AgentSummary,
  type Approval,
  type Room,
  type TaskDetail,
  type TaskSummary,
} from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { ApiError, apiFetch } from '../../data/api.ts'
import { taskColumns, taskDetailKey, useTaskDetail } from './task-queries.ts'

function idempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function errorText(error: unknown) {
  return error instanceof ApiError ? error.message : 'The request failed. Please try again.'
}

// "May I install the pagination dependency?" -> "Approve: install the pagination dependency".
export function approveLabel(title: string) {
  const text = title.trim().replace(/\?+$/, '')
  const request = /^(?:may|can|shall|should) i\s+(.+)$/i.exec(text)?.[1] ?? text
  const label = `Approve: ${request}`
  return label.length > 60 ? `${label.slice(0, 59)}…` : label
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function AgentRow({ agents, id }: { agents: AgentSummary[]; id: string | null }) {
  if (!id) return <span className="task-drawer-muted">None</span>
  const agent = agents.find((item) => item.id === id)
  return (
    <span className="task-drawer-agent">
      <AgentGlyph
        agent={agent ?? { id, name: id, style: { color: '#12131A', shape: 'cross' } }}
        size="xs"
        decorative
      />
      {agent?.name ?? id}
    </span>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="task-drawer-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function Steps({ task }: { task: TaskDetail }) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = taskDetailKey(task.id)

  async function toggle(stepId: string) {
    const before = queryClient.getQueryData<TaskDetail>(key)
    if (!before || saving || readOnly) return
    const steps = before.steps.map((step) =>
      step.id === stepId ? { ...step, done: !step.done } : step,
    )
    setError(null)
    setSaving(true)
    queryClient.setQueryData<TaskDetail>(key, { ...before, steps })
    try {
      const next = TaskDetailSchema.parse(
        await apiFetch(`tasks/${encodeURIComponent(task.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ steps }),
        }),
      )
      queryClient.setQueryData<TaskDetail>(key, next)
    } catch (caught) {
      queryClient.setQueryData<TaskDetail>(key, (current) =>
        current ? { ...current, steps: before.steps } : current,
      )
      if (caught instanceof ApiError && caught.status === 501) setReadOnly(true)
      else setError(`Could not save that step. ${errorText(caught)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="task-drawer-section" aria-labelledby="task-steps-heading">
      <h3 id="task-steps-heading">Steps</h3>
      {task.steps.length === 0 && <p className="task-drawer-muted">No steps yet.</p>}
      <ul className="task-steps">
        {task.steps.map((step) => (
          <li key={step.id}>
            <label className={step.done ? 'task-step task-step--done' : 'task-step'}>
              <input
                type="checkbox"
                checked={step.done}
                disabled={readOnly || saving}
                onChange={() => void toggle(step.id)}
              />
              <span className="task-step-box" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path
                    d="M2.5 6.5 L5 9 L9.5 3.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="task-step-text">{step.text}</span>
            </label>
          </li>
        ))}
      </ul>
      {readOnly && task.steps.length > 0 && (
        <p className="task-drawer-muted" role="status">
          Steps are read-only for now.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

function Actions({ task, agents }: { task: TaskDetail; agents: AgentSummary[] }) {
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null)
  const [sent, setSent] = useState<string[]>([])
  const approval = task.pendingApproval
  const canApprove = Boolean(
    approval?.actionable && approval.phase === 'human_pending' && approval.choices.includes('once'),
  )
  const waiting = approval && sent.includes(approval.id)

  async function run(request: () => Promise<unknown>, success: string) {
    setBusy(true)
    setMessage(null)
    try {
      await request()
      setMessage({ kind: 'status', text: success })
      return true
    } catch (caught) {
      setMessage({ kind: 'alert', text: errorText(caught) })
      return false
    } finally {
      setBusy(false)
      void queryClient.invalidateQueries({ queryKey: taskDetailKey(task.id), exact: true })
    }
  }

  function approve(current: Approval) {
    void run(async () => {
      ApprovalSchema.parse(
        await apiFetch(`approvals/${encodeURIComponent(current.id)}/decision`, {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey() },
          body: JSON.stringify({ choice: 'once' }),
        }),
      )
      setSent((ids) => [...ids, current.id])
    }, 'Approval sent. Waiting for the agent to continue.')
  }

  function action(name: 'comment' | 'unblock', text?: string) {
    void run(
      () =>
        apiFetch(`tasks/${encodeURIComponent(task.id)}/actions`, {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey() },
          body: JSON.stringify({ action: name, ...(text ? { text } : {}) }),
        }),
      name === 'comment' ? 'Comment added.' : 'Task unblocked.',
    ).then((ok) => {
      if (ok && name === 'comment') setComment('')
    })
  }

  const agentName =
    approval && (agents.find((a) => a.id === approval.agentId)?.name ?? approval.agentId)
  return (
    <section className="task-drawer-section task-drawer-actions" aria-label="Task actions">
      {approval && (
        <div className="task-drawer-approval">
          <p className="task-drawer-approval-title">
            <b>{agentName}</b> asks: {approval.title}
          </p>
          {approval.command && <code>{approval.command}</code>}
          {approval.description && <p className="task-drawer-muted">{approval.description}</p>}
          {!approval.actionable && (
            <p className="task-drawer-muted">This approval can only be answered in Hermes.</p>
          )}
        </div>
      )}
      <div className="task-drawer-buttons">
        {canApprove && approval && !waiting && (
          <button
            type="button"
            className="task-drawer-primary"
            disabled={busy}
            onClick={() => approve(approval)}
            // The request is shown in full just above; the pill stays one short line (tasks.png).
            aria-label={approveLabel(approval.title)}
          >
            Approve once
          </button>
        )}
        <Link
          className="task-drawer-secondary"
          to={`/now/flow?task=${encodeURIComponent(task.id)}`}
        >
          See it in Flow
        </Link>
      </div>
      {!canApprove && task.hermesStatus === 'blocked' && (
        <button
          type="button"
          className="task-drawer-secondary"
          disabled={busy}
          onClick={() => action('unblock')}
        >
          Unblock
        </button>
      )}
      {!canApprove && (
        <form
          className="task-drawer-comment"
          onSubmit={(event) => {
            event.preventDefault()
            if (comment.trim()) action('comment', comment.trim())
          }}
        >
          <label htmlFor="task-comment">Comment</label>
          <textarea
            id="task-comment"
            rows={2}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <button
            type="submit"
            className="task-drawer-secondary"
            disabled={busy || !comment.trim()}
          >
            Add comment
          </button>
        </form>
      )}
      <div aria-live="polite">
        {message && <p role={message.kind === 'alert' ? 'alert' : 'status'}>{message.text}</p>}
      </div>
    </section>
  )
}

function Details({
  task,
  agents,
  rooms,
}: {
  task: TaskDetail
  agents: AgentSummary[]
  rooms: Room[]
}) {
  const room = task.roomId ? rooms.find((item) => item.id === task.roomId) : undefined
  const activity = [...task.activity].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const name = (id: string | null) =>
    id === 'you' ? 'You' : id ? (agents.find((agent) => agent.id === id)?.name ?? id) : null
  return (
    <>
      <h2>{task.title}</h2>
      <dl className="task-drawer-rows">
        <Row label="Assigned to">
          <AgentRow agents={agents} id={task.assignee} />
        </Row>
        <Row label="Reviewer">
          <AgentRow agents={agents} id={task.reviewer} />
        </Row>
        <Row label="Created by">{name(task.createdBy) ?? task.createdBy}</Row>
        <Row label="Room">
          {task.roomId ? (
            <Link to={`/chat/${encodeURIComponent(task.roomId)}`}>{room?.name ?? task.roomId}</Link>
          ) : (
            <span className="task-drawer-muted">None</span>
          )}
        </Row>
      </dl>
      {task.body && <p className="task-drawer-body">{task.body}</p>}
      <Steps task={task} />
      <section className="task-drawer-section" aria-labelledby="task-activity-heading">
        <h3 id="task-activity-heading">Activity</h3>
        {activity.length === 0 && <p className="task-drawer-muted">No activity yet.</p>}
        <ol className="task-activity">
          {activity.map((item, index) => (
            <li key={`${item.at}-${index}`}>
              <time dateTime={item.at}>{clock(item.at)}</time>
              <span>
                {name(item.agentId) && <b>{name(item.agentId)} </b>}
                {item.text}
              </span>
            </li>
          ))}
        </ol>
      </section>
      <Actions task={task} agents={agents} />
    </>
  )
}

export function TaskDrawer({
  taskId,
  summary,
  agents,
  rooms,
  closeTo,
  closeRef,
  onKeyDown,
}: {
  taskId: string
  summary: TaskSummary | undefined
  agents: AgentSummary[]
  rooms: Room[]
  closeTo: string
  closeRef: Ref<HTMLAnchorElement>
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
}) {
  const detail = useTaskDetail(taskId)
  const shown = detail.data ?? summary
  const column = taskColumns.find(({ id }) => id === shown?.column)
  return (
    <aside className="task-placeholder task-drawer" aria-label="Task details" onKeyDown={onKeyDown}>
      <div className="task-placeholder-heading">
        {column && (
          <span
            className={`task-drawer-badge${shown?.column === 'needs_you' ? ' task-drawer-badge--needs' : ''}`}
          >
            {column.label}
          </span>
        )}
        <span>{shown?.key ?? taskId}</span>
        <span className="task-drawer-spacer" />
        <Link ref={closeRef} className="task-close" to={closeTo} aria-label="Close details">
          ×
        </Link>
      </div>
      {detail.status === 'pending' && <p role="status">Loading task…</p>}
      {detail.status === 'error' && (
        <div role="alert">
          <p>
            {detail.error instanceof ApiError && detail.error.status === 404
              ? 'This task no longer exists.'
              : 'Task details could not load.'}
          </p>
          <button type="button" className="task-filter" onClick={() => void detail.refetch()}>
            Retry task
          </button>
        </div>
      )}
      {detail.data && <Details task={detail.data} agents={agents} rooms={rooms} />}
    </aside>
  )
}
