import type { AgentSummary, TaskSummary } from '@score/contract'
import { useMemo, useRef, useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { ApiError } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentNameColor } from '../bold-agents.ts'
import { PinCard } from './PinCards.tsx'
import {
  blockedTask,
  roomTasksQuery,
  taskAction,
  taskBlockedReason,
  useTaskRefresh,
} from './task-queries.ts'

export function TaskAgent({ task, agents }: { task: TaskSummary; agents: AgentSummary[] }) {
  const agent = task.assignee ? agents.find((item) => item.id === task.assignee) : undefined
  if (!agent) return <span className="small muted">Unassigned</span>
  return (
    <span className="bold-task-agent" style={{ color: agentNameColor(agent) }}>
      <AgentGlyph agent={agent} size="xs" bare decorative />
      {agent.name}
    </span>
  )
}

type Action = 'unblock' | 'comment'

function TaskActionForm({
  task,
  action,
  onCancel,
}: {
  task: TaskSummary
  action: Action
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const key = useRef(newId())
  const refresh = useTaskRefresh()
  const needsText = action === 'comment' && !text.trim()
  async function submit() {
    if (busy || needsText) return
    setBusy(true)
    setError(null)
    try {
      await taskAction(task.id, action, text, key.current)
      setSent(true)
      refresh()
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500)
        key.current = newId()
      setError(
        failure instanceof ApiError && (failure.status === 401 || failure.status === 403)
          ? 'Pair this browser first.'
          : failure instanceof ApiError && failure.status === 409
            ? failure.message
            : `Couldn’t ${action} this task. Try again.`,
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="bold-task-action-form">
      <label>
        {action === 'unblock' ? 'Note (optional)' : `Comment on ${task.title}`}
        <textarea
          value={text}
          rows={2}
          maxLength={2000}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      {error && (
        <span className="bold-request-error" role="alert">
          {error}
        </span>
      )}
      {sent && (
        <span className="bold-task-sent" role="status">
          Sent — waiting for Hermes
        </span>
      )}
      <span className="row wrap">
        <button
          type="button"
          className="btn sm"
          disabled={busy || needsText || sent}
          onClick={() => void submit()}
        >
          {sent ? 'Sent' : busy ? 'Sending…' : action === 'unblock' ? 'Unblock' : 'Comment'}
        </button>
        <button type="button" className="btn sm ghost" disabled={busy || sent} onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  )
}

function BlockedTaskCard({ task, agents }: { task: TaskSummary; agents: AgentSummary[] }) {
  const [action, setAction] = useState<Action | null>(null)
  const cardKey = `task:${task.id}`
  return (
    <PinCard pinKey={cardKey} since={task.updatedAt} label={`Blocked task: ${task.title}`}>
      <div className="bold-request-head">
        <TaskAgent task={task} agents={agents} />
        <span className="bold-request-job">{task.key}</span>
      </div>
      <b className="bold-request-title">{task.title}</b>
      <span>{taskBlockedReason(task)}</span>
      {action ? (
        <TaskActionForm task={task} action={action} onCancel={() => setAction(null)} />
      ) : (
        <span className="row wrap">
          <button type="button" className="btn sm" onClick={() => setAction('unblock')}>
            Unblock
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setAction('comment')}>
            Comment
          </button>
        </span>
      )}
    </PinCard>
  )
}

export function RoomTaskRequests({
  roomId,
  agents,
  teamRoom,
}: {
  roomId: string
  agents: AgentSummary[]
  teamRoom: boolean
}) {
  const definition = useMemo(() => roomTasksQuery(roomId, teamRoom, true), [roomId, teamRoom])
  const tasks = useStreamQuery(definition).data?.tasks ?? []
  const blocked = tasks.filter(blockedTask)
  if (blocked.length === 0) return null
  return (
    <>
      {blocked.map((task) => (
        <BlockedTaskCard key={task.id} task={task} agents={agents} />
      ))}
    </>
  )
}
