import type { AgentSummary, Approval, ApprovalChoice, Job, Message } from '@score/contract'
import { useEffect, useId, useRef, useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import {
  approvalOutcome,
  useApprovalDecision,
  whereToAnswer,
} from '../../routes/chat/ApprovalCard.tsx'
import { agentDisplayName, agentNameColor } from '../bold-agents.ts'
import { PinCard } from './PinCards.tsx'
import { approvalInRoom } from './room-model.ts'

function ApprovalRequestCard({
  approval,
  job,
  message,
  agents,
}: {
  approval: Approval
  job: Job | undefined
  /** The message that carries the approval: the card sits right after it. */
  message?: string
  agents: AgentSummary[]
}) {
  const { posted, busy, error, decide: submit } = useApprovalDecision(approval.id)
  const [more, setMore] = useState(false)
  const moreButton = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const current = posted && approval.delivery === 'none' ? posted : approval
  const agent = agents.find((item) => item.id === current.agentId)
  const outcome = approvalOutcome(current)
  const retrying = current.actionable && current.delivery === 'failed'
  const open = current.actionable && (outcome === null || retrying) && !busy
  const showButtons = current.actionable && (outcome === null || retrying)
  const choices = current.choices

  useEffect(() => {
    if (!more) return
    function onPointerDown(event: PointerEvent) {
      if (!moreButton.current?.parentElement?.contains(event.target as Node)) setMore(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      setMore(false)
      requestAnimationFrame(() => moreButton.current?.focus())
    }
    document.addEventListener('pointerdown', onPointerDown)
    // This menu can sit inside the phone's side sheet; the menu is the top layer, so it owns the first Escape.
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [more])

  async function decide(choice: ApprovalChoice) {
    setMore(false)
    await submit(choice)
  }

  return (
    <PinCard
      pinKey={`approval:${current.id}`}
      since={current.createdAt}
      label={current.title}
      variant="approval"
      anchor={{ message, job: job?.id }}
    >
      <div className="bold-request-head">
        {current.fromSubagent ? (
          <b>
            A subagent of {agent ? agentDisplayName(agent) : current.agentId} wants to run this
          </b>
        ) : (
          <>
            {agent && <AgentGlyph agent={agent} size="xs" decorative mood="needs" />}
            <b style={agent ? { color: agentNameColor(agent) } : undefined}>
              {agent ? agentDisplayName(agent) : current.agentId}
            </b>
            <span>· {current.title}</span>
          </>
        )}
        {job && <span className="bold-request-job">{job.title}</span>}
      </div>
      {current.command && <code className="bold-request-command">{current.command}</code>}
      {!current.actionable && outcome === null && whereToAnswer(current)}
      {retrying && (
        <span className="bold-request-failed">Couldn’t deliver your answer. Try again.</span>
      )}
      {showButtons && (
        <span className="row wrap bold-approval-actions">
          {choices.includes('once') && (
            <button
              type="button"
              className="btn sm"
              disabled={!open}
              onClick={() => void decide('once')}
            >
              {retrying ? 'Retry' : 'Allow'}
            </button>
          )}
          {choices.includes('deny') && (
            <button
              type="button"
              className="btn sm ghost"
              disabled={!open}
              onClick={() => void decide('deny')}
            >
              Don’t allow
            </button>
          )}
          {(choices.includes('session') || choices.includes('always')) && (
            <span className="bold-approval-more">
              <button
                ref={moreButton}
                type="button"
                className="btn sm ghost"
                aria-expanded={more}
                aria-controls={menuId}
                disabled={!open}
                onClick={() => setMore(!more)}
              >
                More
              </button>
              {more && (
                <div
                  className="bold-approval-menu"
                  id={menuId}
                  role="group"
                  aria-label="More approval choices"
                >
                  {choices.includes('session') && (
                    <button type="button" onClick={() => void decide('session')}>
                      Approve for this session
                    </button>
                  )}
                  {choices.includes('always') && (
                    <button type="button" onClick={() => void decide('always')}>
                      Always allow for {agent ? agentDisplayName(agent) : current.agentId}
                    </button>
                  )}
                </div>
              )}
            </span>
          )}
        </span>
      )}
      {(busy || outcome) && (
        <span className="bold-request-sent" role="status">
          {busy ? 'Sending…' : outcome}
        </span>
      )}
      {error && (
        <span className="bold-request-error" role="alert">
          {error}
        </span>
      )}
    </PinCard>
  )
}

export function RoomApprovals({
  roomId,
  approvals,
  messages,
  jobs,
  selectedJob,
  agents,
}: {
  roomId: string
  approvals: Approval[]
  messages: Message[]
  jobs: Job[]
  selectedJob: string
  agents: AgentSummary[]
}) {
  const cards = approvals.flatMap((approval) => {
    // `approvalsQuery` is global: an approval that names only other rooms belongs to their strips.
    if (!approvalInRoom(approval, roomId)) return []
    const message = messages.find((item) =>
      item.parts.some((part) => part.kind === 'approval' && part.approvalId === approval.id),
    )
    const known = jobs.find((item) => item.id === message?.jobId)
    if (known && selectedJob !== 'all' && known.id !== selectedJob) return []
    // The approvals read is complete; the message window is not. An approval whose message is older than the
    // loaded page still shows as a request card, but with no job chip: the selected/default job is not its job.
    return [{ approval, job: known, message: message?.id }]
  })
  return (
    <>
      {cards.map(({ approval, job, message }) => (
        <ApprovalRequestCard
          key={approval.id}
          approval={approval}
          job={job}
          message={message}
          agents={agents}
        />
      ))}
    </>
  )
}
