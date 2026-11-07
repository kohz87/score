import type { AgentSummary, TaskSummary } from '@score/contract'
import { useId, useState } from 'react'
import { Link } from 'react-router'
import { agentDisplayName } from './bold-agents.ts'
import { BOARD_COLUMNS, boardColumn } from './bold-tasks-model.ts'
import { taskStateLabel, useTaskDetail } from './room/task-queries.ts'
import { ArchiveBox, TaskEditForm, TaskMoves } from './BoldTaskEdit.tsx'
import { AgentTag } from './BoldTasksCards.tsx'
import { NeedsBlock } from './BoldTasksNeeds.tsx'
import { agentOf, roomName, type Lookup } from './bold-tasks-page-model.ts'
import { useTaskPost } from './use-task-post.ts'

function CommentBox({ task, agent }: { task: TaskSummary; agent: AgentSummary | undefined }) {
  const [text, setText] = useState('')
  const post = useTaskPost(task.id, 'comment')
  const id = useId()
  async function submit() {
    if (!text.trim()) return
    if (await post.run(text)) setText('')
  }
  return (
    <form
      className="bold-tb-comment-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <label htmlFor={id}>Add a comment for {agent ? agentDisplayName(agent) : 'the team'}</label>
      <span className="bold-tb-comment-row">
        <input
          id={id}
          type="text"
          value={text}
          maxLength={2000}
          disabled={post.busy}
          placeholder="Say what to change or check"
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="btn sm ghost" disabled={post.busy || !text.trim()}>
          Comment
        </button>
      </span>
      {post.sent && !post.error && <span role="status">Sent — waiting for Hermes</span>}
      {post.error && (
        <span className="bold-request-error" role="alert">
          {post.error}
        </span>
      )}
    </form>
  )
}

const when = (at: string) =>
  new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

export function TaskPanel({
  task,
  lookup,
  onClose,
  onArchived,
}: {
  task: TaskSummary
  lookup: Lookup
  onClose: () => void
  onArchived: () => void
}) {
  const detailQuery = useTaskDetail(task.id)
  const detail = detailQuery.data
  const [editing, setEditing] = useState(false)
  const agent = agentOf(lookup, task.assignee)
  const reviewer = agentOf(lookup, task.reviewer)
  const column =
    BOARD_COLUMNS.find((item) => item.id === boardColumn(task))?.title ?? taskStateLabel(task)
  return (
    <div className="bold-tb-panel-body">
      <span className="bold-tb-panel-top">
        <span>
          {task.key} · Hermes: {task.hermesStatus}
        </span>
        <button
          type="button"
          className="bold-tb-close"
          aria-label="Close task details"
          onClick={onClose}
        >
          ×
        </button>
      </span>
      {editing && detail ? (
        <TaskEditForm detail={detail} agents={lookup.agents} onDone={() => setEditing(false)} />
      ) : (
        <>
          <h2>{task.title}</h2>
          <span className="bold-tb-actions">
            <button
              type="button"
              className="btn sm"
              disabled={!detail}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          </span>
        </>
      )}
      <dl className="bold-tb-facts">
        <dt>Room</dt>
        <dd>{task.roomId ? <Link to="/b">{roomName(lookup, task.roomId)}</Link> : 'No room'}</dd>
        <dt>Doing it</dt>
        <dd>
          <AgentTag agent={agent} />
        </dd>
        <dt>Reviewer</dt>
        <dd>{reviewer ? <AgentTag agent={reviewer} /> : 'None'}</dd>
        <dt>Column</dt>
        <dd>{column}</dd>
      </dl>
      <NeedsBlock task={task} detail={detail} />
      <TaskMoves taskId={task.id} column={boardColumn(task)} />
      <section className="bold-tb-section" aria-label="Steps">
        <h3>Steps</h3>
        {detailQuery.isPending && <p className="bold-tb-empty">Reading steps…</p>}
        {detailQuery.isError && <p className="bold-tb-empty">Couldn’t read its steps.</p>}
        {detail && detail.steps.length === 0 && <p className="bold-tb-empty">No steps yet.</p>}
        {detail && detail.steps.length > 0 && (
          <ul className="bold-tb-steps">
            {detail.steps.map((step) => (
              <li key={step.id} data-done={step.done ? 'true' : 'false'}>
                <span className="bold-tb-box" aria-hidden="true">
                  {step.done ? '✓' : ''}
                </span>
                <span>{step.text}</span>
                <span className="bold-tb-sr">{step.done ? 'done' : 'not done'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="bold-tb-section" aria-label="Comments">
        <h3>Comments</h3>
        {detail?.activity.map((entry, index) => {
          const who = agentOf(lookup, entry.agentId)
          return (
            <div className="bold-tb-comment" key={`${entry.at}-${index}`}>
              <span>
                <strong>{who ? agentDisplayName(who) : 'You'}</strong> · {when(entry.at)}
              </span>
              <span>{entry.text}</span>
            </div>
          )
        })}
        {detail && detail.activity.length === 0 && (
          <p className="bold-tb-empty">No comments yet.</p>
        )}
        <CommentBox task={task} agent={agent} />
      </section>
      <ArchiveBox taskId={task.id} onArchived={onArchived} />
    </div>
  )
}
