import type {
  AgentSummary,
  Approval,
  Exchange,
  ExchangeOption,
  Job,
  Message,
} from '@score/contract'
import { useMemo, useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch, ApiError } from '../../data/api.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { approvalOutcome, useApprovalDecision } from '../../routes/chat/ApprovalCard.tsx'
import { approvalsQuery } from '../../routes/chat/queries.ts'
import { agentNameColor } from '../bold-agents.ts'
import {
  exchangePauseAsk,
  exchangePauseTitle,
  exchangeTurns,
  needsYou,
  optionLabel,
} from './room-model.ts'
import { jobExchangesQuery } from './room-queries.ts'

type PendingOption = ExchangeOption | null

function decisionBody(
  option: ExchangeOption,
  form: { note: string; text: string; agent: string; usd: string },
) {
  switch (option) {
    case 'more_turns':
      return { option, turns: 4 }
    case 'more_spend':
      return { option, usd: Number(form.usd) }
    case 'step_in':
      return { option, text: form.text.trim() }
    case 'reassign':
      return { option, to: form.agent }
    case 'send_back':
      return { option, note: form.note.trim() }
    default:
      return { option }
  }
}

function needsForm(option: ExchangeOption): boolean {
  return ['more_spend', 'step_in', 'reassign', 'send_back'].includes(option)
}

function decisionError(failure: unknown): string {
  if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403))
    return 'Pair this browser first.'
  if (failure instanceof ApiError && failure.status === 409) return failure.message
  return 'Couldn’t send that decision. Try again.'
}

function ExchangeRequestCard({
  exchange,
  job,
  agents,
}: {
  exchange: Exchange
  job: Job
  agents: AgentSummary[]
}) {
  const from = agents.find((agent) => agent.id === exchange.from)
  const to = agents.find((agent) => agent.id === exchange.to)
  const [pending, setPending] = useState<PendingOption>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const options = exchange.pause?.options ?? []
  const reassignChoices = agents.filter(
    (agent) => agent.id !== exchange.from && agent.id !== exchange.to,
  )
  // Reassign never starts on the agent who has the turn (`exchange.to`): the first legal choice is the pick.
  const [form, setForm] = useState({
    note: '',
    text: '',
    agent: reassignChoices[0]?.id ?? '',
    usd: '10',
  })

  async function choose(option: ExchangeOption) {
    if (needsForm(option)) {
      setPending(option)
      setError(null)
      return
    }
    await send(option)
  }

  async function send(option: ExchangeOption) {
    const body = decisionBody(option, form)
    if (option === 'send_back' && !('note' in body && body.note))
      return setError('Write a short note for the author.')
    if (option === 'step_in' && !('text' in body && body.text))
      return setError('Write what you want to happen.')
    if (option === 'reassign' && !('to' in body && body.to)) return setError('Choose an agent.')
    const usd = Number(form.usd)
    if (option === 'more_spend' && (!Number.isFinite(usd) || usd <= 0))
      return setError('Enter an amount above zero.')
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`exchanges/${encodeURIComponent(exchange.id)}/decision`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setSent(option === 'send_back' ? 'Sent back with your note.' : 'Decision sent.')
      setPending(null)
    } catch (failure) {
      setError(decisionError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article
      className="bold-request"
      data-protected="flex"
      aria-label={`Needs you: ${exchangePauseTitle(exchange)}`}
    >
      <div className="bold-request-head">
        {from && <AgentGlyph agent={from} size="xs" decorative />}
        <b style={from ? { color: agentNameColor(from) } : undefined}>{exchange.from}</b>
        {to && (
          <>
            <span className="muted">with</span>
            <b style={{ color: agentNameColor(to) }}>{exchange.to}</b>
          </>
        )}
        <span className="bold-request-job">{job.title}</span>
      </div>
      <b className="bold-request-title">{exchangePauseTitle(exchange)}</b>
      <span>{exchangePauseAsk(exchange)}</span>
      <span className="small muted">{exchangeTurns(exchange)}</span>

      {pending !== null && (
        <div className="bold-request-form">
          {pending === 'send_back' && (
            <label>
              Note for the author
              <textarea
                value={form.note}
                onChange={(event) => setForm({ ...form, note: event.target.value })}
                placeholder="Say what needs to change"
              />
            </label>
          )}
          {pending === 'step_in' && (
            <label>
              What should happen next?
              <textarea
                value={form.text}
                onChange={(event) => setForm({ ...form, text: event.target.value })}
                placeholder="Write the step in"
              />
            </label>
          )}
          {pending === 'reassign' && (
            <label>
              Give the turn to
              <select
                value={form.agent}
                onChange={(event) => setForm({ ...form, agent: event.target.value })}
              >
                {reassignChoices.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {pending === 'more_spend' && (
            <label>
              More spend in dollars
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={form.usd}
                onChange={(event) => setForm({ ...form, usd: event.target.value })}
              />
            </label>
          )}
          <span className="row wrap">
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => void send(pending)}
            >
              {busy ? 'Sending…' : optionLabel(pending)}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
          </span>
        </div>
      )}

      {pending === null && !sent && (
        <span className="row wrap">
          {options.map((option, index) => (
            <button
              key={option}
              type="button"
              className={`btn sm${index === 0 ? '' : ' ghost'}`}
              disabled={busy}
              onClick={() => void choose(option)}
            >
              {optionLabel(option)}
            </button>
          ))}
        </span>
      )}
      {sent && (
        <span className="bold-request-sent" role="status">
          {sent}
        </span>
      )}
      {error && (
        <span className="bold-request-error" role="alert">
          {error}
        </span>
      )}
    </article>
  )
}

function JobRequests({ job, agents }: { job: Job; agents: AgentSummary[] }) {
  const definition = useMemo(() => jobExchangesQuery(job.id), [job.id])
  const exchanges = useStreamQuery(definition).data ?? []
  return (
    <>
      {exchanges.filter(needsYou).map((exchange) => (
        <ExchangeRequestCard key={exchange.id} exchange={exchange} job={job} agents={agents} />
      ))}
    </>
  )
}

function ApprovalRequestCard({
  approval,
  job,
  agents,
}: {
  approval: Approval
  job: Job | undefined
  agents: AgentSummary[]
}) {
  const { posted, busy, error, decide } = useApprovalDecision(approval.id)
  const current = posted && approval.delivery === 'none' ? posted : approval
  const agent = agents.find((item) => item.id === current.agentId)
  const outcome = approvalOutcome(current)
  const open = current.actionable && outcome === null && !busy
  const choices = current.choices
  return (
    <article
      className="bold-request bold-approval"
      data-protected="flex"
      aria-label={`Needs you: ${current.title}`}
    >
      <div className="bold-request-head">
        {agent && <AgentGlyph agent={agent} size="xs" decorative />}
        <b style={agent ? { color: agentNameColor(agent) } : undefined}>{current.agentId}</b>
        <span>· {current.title}</span>
        {job && <span className="bold-request-job">{job.title}</span>}
      </div>
      {current.command && <code className="bold-request-command">{current.command}</code>}
      <span className="row wrap">
        {choices.includes('once') && (
          <button
            type="button"
            className="btn sm"
            disabled={!open}
            onClick={() => void decide('once')}
          >
            Allow
          </button>
        )}
        {!choices.includes('once') && choices.includes('session') && (
          <button
            type="button"
            className="btn sm"
            disabled={!open}
            onClick={() => void decide('session')}
          >
            Allow for this session
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
        {choices.includes('always') && (
          <button
            type="button"
            className="btn sm ghost"
            disabled={!open}
            onClick={() => void decide('always')}
          >
            Always allow for {current.agentId}
          </button>
        )}
      </span>
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
    </article>
  )
}

function RoomApprovals({
  approvals,
  messages,
  jobs,
  selectedJob,
  agents,
}: {
  approvals: Approval[]
  messages: Message[]
  jobs: Job[]
  selectedJob: string
  agents: AgentSummary[]
}) {
  return (
    <>
      {approvals.map((approval) => {
        const message = messages.find((item) =>
          item.parts.some((part) => part.kind === 'approval' && part.approvalId === approval.id),
        )
        const known = jobs.find((item) => item.id === message?.jobId)
        if (known && selectedJob !== 'all' && known.id !== selectedJob) return null
        // The approvals read is complete; the message window is not. An approval whose message is older than the
        // loaded page still shows as a request card (with the selected/default job as its reference).
        const job =
          known ??
          jobs.find((item) => item.id === selectedJob) ??
          jobs.find((item) => item.isDefault) ??
          jobs[0]
        return (
          <ApprovalRequestCard key={approval.id} approval={approval} job={job} agents={agents} />
        )
      })}
    </>
  )
}

/** The "Needs you" pins: each job's paused exchanges and approvals, shown above the stream and never scrolled away. */
export function RoomRequests({
  jobs,
  agents,
  messages,
  selectedJob,
}: {
  jobs: Job[]
  agents: AgentSummary[]
  messages?: Message[]
  selectedJob: string
}) {
  const approvals = useStreamQuery(approvalsQuery).data ?? []
  const cooking = jobs.filter(
    (job) =>
      (selectedJob === 'all' || job.id === selectedJob) &&
      (job.state === 'waiting_on_you' || job.state === 'working'),
  )
  const needsApproval = approvals.filter(
    (approval) => approval.actionable && approval.phase === 'human_pending',
  )
  return (
    <div className="bold-pins" aria-label="Needs you">
      {cooking.map((job) => (
        <JobRequests key={job.id} job={job} agents={agents} />
      ))}
      <RoomApprovals
        approvals={needsApproval}
        messages={messages ?? []}
        jobs={jobs}
        selectedJob={selectedJob}
        agents={agents}
      />
    </div>
  )
}
