import { ApprovalSchema, type Approval, type ApprovalChoice } from '@score/contract'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ApiError, apiFetch } from '../../data/api.ts'
import { useStream, useStreamQuery } from '../../data/query-client.ts'
import { approvalsQuery } from './queries.ts'
import { newId } from '../../data/ids.ts'

function idempotencyKey() {
  return newId()
}

export const choiceText: Record<ApprovalChoice, string> = {
  once: 'You approved',
  session: 'You approved for this session',
  always: 'You approved always',
  deny: 'You denied',
}

// The one line that says how this approval ended up, or null while it is still open.
export function approvalOutcome(approval: Approval): string | null {
  if (approval.delivery === 'not_pending') return 'Answered elsewhere'
  if (approval.delivery === 'unknown') return 'May have been answered'
  if (approval.delivery === 'intent' || approval.delivery === 'delivering') return 'Sending…'
  const { decision } = approval
  if (decision) {
    const verb = decision.choice === 'deny' ? 'denied' : 'approved'
    if (decision.by === 'you') return choiceText[decision.choice]
    if (decision.by === 'guardian') return `Guardian ${verb} this`
    if (decision.by === 'rule') return `A rule ${verb} this`
    if (decision.by === 'timeout') return 'Timed out'
    return `Answered elsewhere (${verb})`
  }
  if (approval.status === 'expired') return 'Expired'
  if (approval.status === 'withdrawn') return 'Withdrawn'
  if (approval.status === 'unknown') return 'May have been answered'
  return null
}

function whereToAnswer(approval: Approval) {
  const task = approval.refs.find((ref) => ref.kind === 'task')
  if (approval.origin === 'kanban' && task)
    return (
      <p className="chat-approval-note">
        Answer this on the task.{' '}
        <Link to={`/tasks/${encodeURIComponent(task.taskId)}`}>Open the task</Link>
      </p>
    )
  if (approval.origin === 'gateway')
    return <p className="chat-approval-note">Answer in the gateway chat.</p>
  return <p className="chat-approval-note">This approval can only be answered in Hermes.</p>
}

const approvalKey = (approvalId: string) => ['chat', 'approval', approvalId] as const

// The list only holds the newest approvals, so an older one is read by id and kept live from the stream.
function useApprovalById(approvalId: string, enabled: boolean) {
  const queryClient = useQueryClient()
  const stream = useStream()
  useEffect(
    () =>
      stream.subscribe((event) => {
        if (
          (event.type === 'approval.updated' || event.type === 'approval.requested') &&
          event.data.id === approvalId
        )
          queryClient.setQueryData(approvalKey(approvalId), event.data)
      }),
    [stream, queryClient, approvalId],
  )
  return useQuery({
    queryKey: approvalKey(approvalId),
    queryFn: async ({ signal }) =>
      ApprovalSchema.parse(
        await apiFetch(`approvals/${encodeURIComponent(approvalId)}`, { signal }),
      ),
    enabled,
    retry: false,
  })
}

// The one decision path for every approval card (Chat and Now): POST once with an idempotency key.
export function useApprovalDecision(approvalId: string) {
  const [posted, setPosted] = useState<Approval | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function decide(choice: ApprovalChoice) {
    setBusy(true)
    setError(null)
    try {
      const result = ApprovalSchema.parse(
        await apiFetch(`approvals/${encodeURIComponent(approvalId)}/decision`, {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey() },
          body: JSON.stringify({ choice }),
        }),
      )
      setPosted(result)
      return result
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'The request failed. Please try again.',
      )
      return null
    } finally {
      setBusy(false)
    }
  }
  return { posted, busy, error, decide }
}

export function ApprovalCard({ approvalId }: { approvalId: string }) {
  const { data, status } = useStreamQuery(approvalsQuery)
  const { posted, busy, error, decide: submit } = useApprovalDecision(approvalId)
  const [more, setMore] = useState(false)
  const listed = data?.find((item) => item.id === approvalId)
  const byId = useApprovalById(approvalId, status === 'success' && !listed)
  const known = listed ?? byId.data
  // The POST response is fresher than the list until the stream catches up.
  const approval = posted && (!known || known.delivery === 'none') ? posted : known
  if (!approval) {
    const loading = status === 'pending' || byId.isLoading
    const notFound = byId.error instanceof ApiError && byId.error.status === 404
    return (
      <div className="chat-approval chat-approval--done" role="status">
        <span>
          {loading
            ? 'Loading approval…'
            : status === 'error' || (byId.isError && !notFound)
              ? 'Could not load this approval.'
              : 'This approval is no longer available.'}
        </span>
      </div>
    )
  }
  const outcome = approvalOutcome(approval)
  const open = approval.actionable && outcome === null && !busy
  const retrying = approval.actionable && approval.delivery === 'failed'
  async function decide(choice: ApprovalChoice) {
    setMore(false)
    await submit(choice)
  }
  const showButtons = approval.actionable && (outcome === null || retrying)
  return (
    <div
      className={`chat-approval${showButtons || busy ? '' : ' chat-approval--done'}`}
      role="group"
      aria-label={`Approval: ${approval.title}`}
    >
      <div className="chat-approval-body">
        <span className="chat-approval-title">{approval.title}</span>
        {approval.command && <code className="chat-approval-command">{approval.command}</code>}
        {approval.description && approval.description !== approval.title && (
          <span className="chat-approval-description">{approval.description}</span>
        )}
        {!approval.actionable && outcome === null && whereToAnswer(approval)}
        {(outcome !== null || busy) && (
          <span className="chat-approval-outcome" role="status">
            {busy ? 'Sending…' : outcome}
          </span>
        )}
        {retrying && (
          <span className="chat-approval-note">Delivery failed. You can try again.</span>
        )}
        {error && (
          <span className="chat-approval-note" role="alert">
            {error}
          </span>
        )}
      </div>
      {showButtons && (
        <div className="chat-approval-actions">
          {approval.choices.includes('once') && (
            <button type="button" disabled={!open && !retrying} onClick={() => void decide('once')}>
              Approve
            </button>
          )}
          {approval.choices.includes('deny') && (
            <button
              type="button"
              className="chat-approval-deny"
              disabled={!open && !retrying}
              onClick={() => void decide('deny')}
            >
              Deny
            </button>
          )}
          {(approval.choices.includes('session') || approval.choices.includes('always')) && (
            <div className="chat-approval-more">
              <button
                type="button"
                className="chat-approval-deny"
                aria-haspopup="menu"
                aria-expanded={more}
                disabled={!open && !retrying}
                onClick={() => setMore(!more)}
              >
                More
              </button>
              {more && (
                <ul role="menu" aria-label="More choices">
                  {approval.choices.includes('session') && (
                    <li role="none">
                      <button type="button" role="menuitem" onClick={() => void decide('session')}>
                        Approve for this session
                      </button>
                    </li>
                  )}
                  {approval.choices.includes('always') && (
                    <li role="none">
                      <button type="button" role="menuitem" onClick={() => void decide('always')}>
                        Always approve
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
