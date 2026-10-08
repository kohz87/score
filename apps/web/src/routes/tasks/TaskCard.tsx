import type { AgentSummary, TaskSummary } from '@score/contract'
import type { CSSProperties, KeyboardEvent, Ref } from 'react'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'

const agentTextTokens: Record<string, string> = {
  '#6B4EFF': 'var(--agent-violet-text)',
  '#19C39A': 'var(--agent-jade-text)',
  '#FFB61E': 'var(--agent-saffron-text)',
  '#FF6B8A': 'var(--agent-coral-text)',
}

export function elapsedTime(seconds: number) {
  if (seconds < 1) return 'just now'
  if (seconds < 60) return `${seconds} sec`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${Math.floor(seconds / 3600)} hr${minutes ? ` ${minutes} min` : ''}`
}

function TaskAgent({
  agent,
  id,
  reviewer = false,
}: {
  agent?: AgentSummary
  id: string
  reviewer?: boolean
}) {
  return (
    <span
      className={`task-agent${reviewer ? ' task-agent--reviewer' : ''}`}
      title={reviewer ? `Reviewer: ${agent?.name ?? id}` : undefined}
    >
      <AgentGlyph
        agent={agent ?? { id, name: id, style: { color: '#12131A', shape: 'cross' } }}
        size="xs"
        decorative
      />
      <span>{agent?.name ?? id}</span>
      {reviewer && <span className="tasks-sr-only"> (reviewer)</span>}
    </span>
  )
}

export function TaskCard({
  task,
  agents,
  roomName,
  selected,
  to,
  cardRef,
  onKeyDown,
}: {
  task: TaskSummary
  agents: AgentSummary[]
  roomName: string | undefined
  selected: boolean
  to: string
  cardRef: Ref<HTMLAnchorElement>
  onKeyDown: (event: KeyboardEvent<HTMLAnchorElement>) => void
}) {
  const assignee = agents.find((agent) => agent.id === task.assignee)
  const reviewer = agents.find((agent) => agent.id === task.reviewer)
  const active = task.column === 'working' && task.progress !== null
  const color = assignee?.style.color ?? 'var(--ink)'
  const style = {
    '--task-color': color,
    '--task-agent-text': assignee
      ? (agentTextTokens[assignee.style.color.toUpperCase()] ?? 'var(--ink)')
      : 'var(--ink)',
    '--task-active-border':
      color.toUpperCase() === '#6B4EFF' ? 'var(--agent-violet-border)' : color,
  } as CSSProperties
  const showNote =
    task.note !== null &&
    (task.column === 'needs_you' || task.column === 'in_review' || task.elapsedSec !== null)
  return (
    <Link
      ref={cardRef}
      to={to}
      className={`task-card${active ? ' task-card--working' : ''} task-card--${task.column}`}
      style={style}
      aria-label={`${task.key}: ${task.title}`}
      aria-current={selected ? 'true' : undefined}
      onKeyDown={onKeyDown}
    >
      <span className="task-card-title">{task.title}</span>
      {task.badge && (
        <span className={`task-badge task-badge--${task.badge.kind}`}>{task.badge.label}</span>
      )}
      {active && (
        <span
          className="task-progress"
          role="progressbar"
          aria-label={`${task.title} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(task.progress! * 100)}
        >
          <span style={{ width: `${task.progress! * 100}%` }} />
        </span>
      )}
      {showNote && <span className="task-card-note">{task.note}</span>}
      <span className="task-card-meta">
        {task.assignee ? (
          <TaskAgent agent={assignee} id={task.assignee} />
        ) : (
          <span className="task-card-secondary">Unassigned</span>
        )}
        <span className="task-card-secondary task-card-trailing">
          {task.column === 'in_review' && task.reviewer ? (
            <TaskAgent agent={reviewer} id={task.reviewer} reviewer />
          ) : task.elapsedSec !== null ? (
            elapsedTime(task.elapsedSec)
          ) : !showNote ? (
            task.note
          ) : null}
        </span>
      </span>
      {task.roomId && <span className="task-card-room">{roomName ?? task.roomId}</span>}
    </Link>
  )
}
