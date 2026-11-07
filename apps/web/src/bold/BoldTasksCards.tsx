import type { AgentSummary, TaskColumn, TaskSummary } from '@score/contract'
import { useState } from 'react'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { agentDisplayName, agentNameColor } from './bold-agents.ts'
import { boardColumn, DONE_LIMIT, elapsedLabel, progressPercent } from './bold-tasks-model.ts'
import { agentOf, roomName, type Lookup } from './bold-tasks-page-model.ts'

export function AgentTag({ agent }: { agent: AgentSummary | undefined }) {
  if (!agent) return <span className="bold-tb-agent bold-tb-agent--none">Unassigned</span>
  return (
    <span className="bold-tb-agent" style={{ color: agentNameColor(agent) }}>
      <AgentGlyph agent={agent} size="xs" bare decorative />
      {agentDisplayName(agent)}
    </span>
  )
}

function TaskBadge({ task }: { task: TaskSummary }) {
  if (!task.badge) return null
  return (
    <span className={`bold-tb-badge bold-tb-badge--${task.badge.kind}`}>{task.badge.label}</span>
  )
}

function Progress({ task }: { task: TaskSummary }) {
  const percent = progressPercent(task)
  if (percent === null) return null
  return (
    <span
      className="bold-tb-progress"
      role="progressbar"
      aria-label={`Progress on ${task.title}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ width: `${percent}%` }} />
    </span>
  )
}

export function CardBody({ task, lookup }: { task: TaskSummary; lookup: Lookup }) {
  return (
    <>
      <span className="bold-tb-card-top">
        <span>{task.key}</span>
        <span>{roomName(lookup, task.roomId)}</span>
      </span>
      <span className="bold-tb-card-title">{task.title}</span>
      <TaskBadge task={task} />
      <Progress task={task} />
      <span className="bold-tb-card-foot">
        <AgentTag agent={agentOf(lookup, task.assignee)} />
        <span className="bold-tb-time">{elapsedLabel(task)}</span>
      </span>
    </>
  )
}

function TaskCard({
  task,
  lookup,
  selected,
  onPick,
}: {
  task: TaskSummary
  lookup: Lookup
  selected: boolean
  onPick: () => void
}) {
  const needs = boardColumn(task) === 'needs_you'
  return (
    <button
      type="button"
      className={`bold-tb-card${needs ? ' bold-tb-need' : ''}`}
      // A card that waits for the person is a decision marker no theme may hide.
      data-protected={needs ? 'flex' : undefined}
      aria-pressed={selected}
      aria-label={`${task.key} ${task.title}`}
      onClick={onPick}
    >
      <CardBody task={task} lookup={lookup} />
    </button>
  )
}

export function Column({
  id,
  title,
  tasks,
  lookup,
  selectedId,
  onPick,
  filtered,
}: {
  id: TaskColumn
  title: string
  tasks: TaskSummary[]
  lookup: Lookup
  selectedId: string | null
  onPick: (id: string) => void
  filtered: boolean
}) {
  const [older, setOlder] = useState(false)
  const shown = id === 'done' && !older ? tasks.slice(0, DONE_LIMIT) : tasks
  const hidden = tasks.length - shown.length
  return (
    <section className="bold-tb-col" aria-label={title} data-column={id}>
      <h2>
        <span>{title}</span>
        <span className="bold-tb-count">{tasks.length}</span>
      </h2>
      {shown.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          lookup={lookup}
          selected={task.id === selectedId}
          onPick={() => onPick(task.id)}
        />
      ))}
      {hidden > 0 && (
        <button type="button" className="btn sm ghost" onClick={() => setOlder(true)}>
          Show older ({hidden})
        </button>
      )}
      {tasks.length === 0 && (
        <p className="bold-tb-empty">
          {filtered ? 'Nothing here for this filter.' : 'Nothing here.'}
        </p>
      )}
    </section>
  )
}
