import type { AgentSummary, Approval, Job, Message } from '@score/contract'
import { Link } from 'react-router'
import { useApprovalDecision } from '../routes/chat/ApprovalCard.tsx'
import { clock } from '../routes/watch/watch-model.ts'
import { agentDisplayName } from './bold-agents.ts'
import { boldJobLink } from './bold-links.ts'
import { approvalNeedsYou } from './room/room-model.ts'

function pendingApproval(approvals: Approval[], agentId: string): Approval | null {
  const open = approvals.filter((item) => item.agentId === agentId && approvalNeedsYou(item))
  return open.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
}

function ApprovalBar({
  approval,
  agent,
  jobs,
  messages,
}: {
  approval: Approval
  agent: AgentSummary
  jobs: Job[]
  messages: Message[]
}) {
  const { busy, error, posted, decide } = useApprovalDecision(approval.id)
  const answered = posted !== null && posted.status !== 'pending'
  const current = posted ?? approval
  const sending = current.delivery === 'intent' || current.delivery === 'delivering'
  const retrying = current.actionable && current.delivery === 'failed'
  const disabled = busy || answered || sending
  const jobId = approvalJobId(current, jobs, messages)
  return (
    <div
      className="watch-approval bold-screen-approval"
      role="group"
      aria-label="Approval needed"
      data-protected="flex"
    >
      <span className="bold-screen-asked">Asked you at {clock(approval.createdAt)}</span>
      <span className="watch-approval__text">
        {approval.subagentId ? (
          <>
            A subagent of {agentDisplayName(agent)} wants to run this
            {approval.command ? (
              <>
                : <code>{approval.command}</code>
              </>
            ) : (
              <>: {approval.title}</>
            )}
          </>
        ) : (
          <>
            {agentDisplayName(agent)} stopped
            {approval.command ? (
              <>
                {' '}
                before <code>{approval.command}</code>
              </>
            ) : (
              <>: {approval.title}</>
            )}{' '}
            and is waiting for you
          </>
        )}
        {sending && <span className="bold-screen-answer"> Sending…</span>}
        {retrying && (
          <span className="bold-screen-answer"> Couldn’t deliver your answer. Try again.</span>
        )}
        {error && (
          <span className="watch-approval__error" role="alert">
            {' '}
            {error}
          </span>
        )}
        {answered && <span className="bold-screen-answer">Answer sent.</span>}
      </span>
      <span className="bold-screen-approval-actions">
        {approval.actionable && approval.choices.includes('once') && (
          <button
            type="button"
            className="watch-approval__go"
            disabled={disabled}
            onClick={() => void decide('once')}
          >
            {sending ? 'Sending…' : retrying ? 'Retry' : 'Approve'}
          </button>
        )}
        {approval.actionable && approval.choices.includes('deny') && (
          <button
            type="button"
            className="watch-approval__no"
            disabled={disabled}
            onClick={() => void decide('deny')}
          >
            {sending ? 'Sending…' : 'Deny'}
          </button>
        )}
        {!approval.actionable && (
          <Link className="watch-approval__link" to={jobId ? boldJobLink(jobId) : '/b'}>
            {jobId ? 'Answer in the job' : 'Answer in the team room'}
          </Link>
        )}
      </span>
    </div>
  )
}

/** The job that holds the approval's card message; the contract's Approval itself has no job id. */
function approvalJobId(approval: Approval, jobs: Job[], messages: Message[]): string | null {
  const message = messages.find((item) =>
    item.parts.some((part) => part.kind === 'approval' && part.approvalId === approval.id),
  )
  return message?.jobId && jobs.some((job) => job.id === message.jobId) ? message.jobId : null
}

export function BoldScreenAsk({
  live,
  approvals,
  agent,
  jobs,
  messages,
  onGoLive,
}: {
  live: boolean
  approvals: Approval[]
  agent: AgentSummary
  jobs: Job[]
  messages: Message[]
  onGoLive: () => void
}) {
  const waiting = pendingApproval(approvals, agent.id)
  return (
    <div className="bold-screen-ask">
      {live && waiting && (
        <ApprovalBar
          key={waiting.id}
          approval={waiting}
          agent={agent}
          jobs={jobs}
          messages={messages}
        />
      )}
      {!live && waiting && (
        <button
          type="button"
          className="bold-screen-needs-live"
          data-protected="inline-flex"
          onClick={onGoLive}
        >
          Needs you — go live
        </button>
      )}
    </div>
  )
}
