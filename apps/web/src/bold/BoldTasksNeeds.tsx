import type { TaskDetail, TaskSummary } from '@score/contract'
import { Link } from 'react-router'
import { useApprovalDecision, approvalOutcome } from '../routes/chat/ApprovalCard.tsx'
import { useStreamQuery } from '../data/query-client.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { agentDisplayName } from './bold-agents.ts'
import { blockedTask, taskBlockedReason } from './room/task-queries.ts'
import { CardBody } from './BoldTasksCards.tsx'
import type { Lookup } from './bold-tasks-page-model.ts'
import { useTaskPost } from './use-task-post.ts'

function TaskApproval({ detail }: { detail: TaskDetail }) {
  const approval = detail.pendingApproval
  const agents = useStreamQuery(agentsQuery).data ?? []
  const { posted, busy, error, decide } = useApprovalDecision(approval?.id ?? '')
  if (!approval) return null
  const current = posted && approval.delivery === 'none' ? posted : approval
  const owner = agents.find((agent) => agent.id === current.agentId)
  const outcome = approvalOutcome(current)
  const open = current.actionable && outcome === null && !busy
  return (
    <div className="bold-tb-approval">
      {current.subagentId && (
        <span>
          A subagent of {owner ? agentDisplayName(owner) : current.agentId} wants to run this
        </span>
      )}
      <b>{current.title}</b>
      {current.command && <code className="bold-tb-command">{current.command}</code>}
      {!current.actionable && outcome === null && (
        <span>Answer this in Hermes where the task was created.</span>
      )}
      {current.actionable && outcome === null && (
        <span className="bold-tb-actions">
          {current.choices.includes('once') && (
            <button
              type="button"
              className="btn sm"
              disabled={!open}
              onClick={() => void decide('once')}
            >
              Allow
            </button>
          )}
          {current.choices.includes('deny') && (
            <button
              type="button"
              className="btn sm ghost"
              disabled={!open}
              onClick={() => void decide('deny')}
            >
              Don’t allow
            </button>
          )}
        </span>
      )}
      {(busy || outcome) && <span role="status">{busy ? 'Sending…' : outcome}</span>}
      {error && (
        <span className="bold-request-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

export function NeedsBlock({
  task,
  detail,
}: {
  task: TaskSummary
  detail: TaskDetail | undefined
}) {
  const unblock = useTaskPost(task.id, 'unblock')
  const approval = detail?.pendingApproval ?? null
  const blocked = blockedTask(task)
  if (!blocked && !approval) return null
  return (
    <div className="bold-tb-needs-block" data-protected="flex" aria-label="Needs you">
      <span className="bold-tb-kicker">Needs you</span>
      {approval ? (
        <TaskApproval detail={detail!} />
      ) : (
        <>
          <p>{taskBlockedReason(task)}</p>
          <span className="bold-tb-actions">
            <button
              type="button"
              className="btn sm"
              disabled={unblock.busy || unblock.sent}
              onClick={() => void unblock.run()}
            >
              {unblock.sent ? 'Sent' : unblock.busy ? 'Sending…' : 'Unblock'}
            </button>
          </span>
          {unblock.sent && <span role="status">Sent — waiting for Hermes</span>}
          {unblock.error && (
            <span className="bold-request-error" role="alert">
              {unblock.error}
            </span>
          )}
        </>
      )}
      <Link className="bold-tb-room-link" to="/b">
        Open in its room
      </Link>
    </div>
  )
}

export function PhoneNeedsCard({
  task,
  lookup,
  onOpen,
}: {
  task: TaskSummary
  lookup: Lookup
  onOpen: () => void
}) {
  const unblock = useTaskPost(task.id, 'unblock')
  // Unblock only what Hermes itself has blocked (it refuses the rest); anything else in Needs you, such as a task
  // waiting on an approval, is decided in its details, where the approval is (the summary doesn't carry it).
  const blocked = task.hermesStatus === 'blocked'
  const reason = taskBlockedReason(task)
  return (
    <article className="bold-tb-need bold-tb-need--phone" data-protected="flex">
      <CardBody task={task} lookup={lookup} />
      {reason && reason !== task.badge?.label && <span>{reason}</span>}
      <span className="bold-tb-actions">
        {blocked ? (
          <>
            <button
              type="button"
              className="btn sm"
              disabled={unblock.busy || unblock.sent}
              onClick={() => void unblock.run()}
            >
              {unblock.sent ? 'Sent' : unblock.busy ? 'Sending…' : 'Unblock'}
            </button>
            <button type="button" className="btn sm ghost bold-tb-need-more" onClick={onOpen}>
              Details
            </button>
          </>
        ) : (
          <button type="button" className="btn sm" onClick={onOpen}>
            Review and decide
          </button>
        )}
      </span>
      {unblock.sent && <span role="status">Sent — waiting for Hermes</span>}
      {unblock.error && (
        <span className="bold-request-error" role="alert">
          {unblock.error}
        </span>
      )}
    </article>
  )
}
