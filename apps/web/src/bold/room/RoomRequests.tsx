import type {
  AgentSummary,
  Approval,
  ApprovalChoice,
  Exchange,
  ExchangeOption,
  Job,
  Message,
} from '@score/contract'
import { useEffect, useMemo, useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch, ApiError } from '../../data/api.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import {
  approvalOutcome,
  useApprovalDecision,
  whereToAnswer,
} from '../../routes/chat/ApprovalCard.tsx'
import { approvalsQuery } from '../../routes/chat/queries.ts'
import { agentNameColor } from '../bold-agents.ts'
import { ChevronIcon } from '../BoldIcons.tsx'
import {
  exchangePauseAsk,
  exchangePauseTitle,
  exchangeTurns,
  needsYou,
  optionLabel,
  pinsMoreLabel,
} from './room-model.ts'
import { roomExchangesQuery } from './room-queries.ts'
import { RunSafetyRequests, type CountCards } from './RunSafetyRequests.tsx'

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

function useReportedCount(id: string, count: number, report: CountCards) {
  useEffect(() => {
    report(id, count)
  }, [count, id, report])
  useEffect(() => () => report(id, 0), [id, report])
}

function ExchangeRequestCard({
  exchange,
  job,
  agents,
  onAnswered,
}: {
  exchange: Exchange
  job: Job
  agents: AgentSummary[]
  onAnswered: (id: string) => void
}) {
  const from = agents.find((agent) => agent.id === exchange.from)
  const to = agents.find((agent) => agent.id === exchange.to)
  const [pending, setPending] = useState<PendingOption>(null)
  const [busy, setBusy] = useState(false)
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
      onAnswered(exchange.id)
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

      {pending === null && (
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
      {error && (
        <span className="bold-request-error" role="alert">
          {error}
        </span>
      )}
    </article>
  )
}

function RoomExchanges({
  jobs,
  agents,
  dismissed,
  report,
  onAnswered,
}: {
  jobs: Job[]
  agents: AgentSummary[]
  dismissed: ReadonlySet<string>
  report: CountCards
  onAnswered: (id: string) => void
}) {
  const definition = useMemo(() => roomExchangesQuery(jobs.map((job) => job.id)), [jobs])
  const exchanges = useStreamQuery(definition).data ?? []
  const visible = exchanges.filter((exchange) => needsYou(exchange) && !dismissed.has(exchange.id))
  useReportedCount('exchanges', visible.length, report)
  return (
    <>
      {visible.map((exchange) => {
        const job = jobs.find((item) => item.id === exchange.jobId)
        return job ? (
          <ExchangeRequestCard
            key={exchange.id}
            exchange={exchange}
            job={job}
            agents={agents}
            onAnswered={onAnswered}
          />
        ) : null
      })}
    </>
  )
}

function ApprovalRequestCard({
  approval,
  job,
  agents,
  onAnswered,
}: {
  approval: Approval
  job: Job | undefined
  agents: AgentSummary[]
  onAnswered: (id: string) => void
}) {
  const { posted, busy, error, decide: submit } = useApprovalDecision(approval.id)
  const [more, setMore] = useState(false)
  const current = posted && approval.delivery === 'none' ? posted : approval
  const agent = agents.find((item) => item.id === current.agentId)
  const outcome = approvalOutcome(current)
  const retrying = current.actionable && current.delivery === 'failed'
  const open = current.actionable && (outcome === null || retrying) && !busy
  const showButtons = current.actionable && (outcome === null || retrying)
  const choices = current.choices

  async function decide(choice: ApprovalChoice) {
    setMore(false)
    const result = await submit(choice)
    if (result && result.delivery !== 'failed') onAnswered(current.id)
  }

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
              Allow
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
                type="button"
                className="btn sm ghost"
                aria-haspopup="menu"
                aria-expanded={more}
                disabled={!open}
                onClick={() => setMore(!more)}
              >
                More
              </button>
              {more && (
                <ul role="menu" aria-label="More approval choices">
                  {choices.includes('session') && (
                    <li role="none">
                      <button type="button" role="menuitem" onClick={() => void decide('session')}>
                        Approve for this session
                      </button>
                    </li>
                  )}
                  {choices.includes('always') && (
                    <li role="none">
                      <button type="button" role="menuitem" onClick={() => void decide('always')}>
                        Always allow for {current.agentId}
                      </button>
                    </li>
                  )}
                </ul>
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
    </article>
  )
}

function RoomApprovals({
  approvals,
  messages,
  jobs,
  selectedJob,
  agents,
  dismissed,
  report,
  onAnswered,
}: {
  approvals: Approval[]
  messages: Message[]
  jobs: Job[]
  selectedJob: string
  agents: AgentSummary[]
  dismissed: ReadonlySet<string>
  report: CountCards
  onAnswered: (id: string) => void
}) {
  const cards = approvals.flatMap((approval) => {
    if (dismissed.has(approval.id) || approvalOutcome(approval) !== null) return []
    const message = messages.find((item) =>
      item.parts.some((part) => part.kind === 'approval' && part.approvalId === approval.id),
    )
    const known = jobs.find((item) => item.id === message?.jobId)
    if (known && selectedJob !== 'all' && known.id !== selectedJob) return []
    // The approvals read is complete; the message window is not. An approval whose message is older than the
    // loaded page still shows as a request card (with the selected/default job as its reference).
    const job =
      known ??
      jobs.find((item) => item.id === selectedJob) ??
      jobs.find((item) => item.isDefault) ??
      jobs[0]
    return [{ approval, job }]
  })
  useReportedCount('approvals', cards.length, report)
  return (
    <>
      {cards.map(({ approval, job }) => (
        <ApprovalRequestCard
          key={approval.id}
          approval={approval}
          job={job}
          agents={agents}
          onAnswered={onAnswered}
        />
      ))}
    </>
  )
}

/** The "Needs you" pins: approvals, paused exchanges and run-safety cards above the stream. */
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
  const [dismissedApprovals, setDismissedApprovals] = useState<Set<string>>(new Set())
  const [dismissedExchanges, setDismissedExchanges] = useState<Set<string>>(new Set())
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [expanded, setExpanded] = useState(false)
  const report: CountCards = useMemo(
    () => (id, count) =>
      setCounts((current) => (current[id] === count ? current : { ...current, [id]: count })),
    [],
  )
  const selectedJobs = jobs.filter((job) => selectedJob === 'all' || job.id === selectedJob)
  const cooking = selectedJobs.filter(
    (job) => job.state === 'waiting_on_you' || job.state === 'working',
  )
  const recipeJobs = selectedJobs.filter((job) => job.recipe !== null)
  const needsApproval = approvals.filter((approval) => approval.phase === 'human_pending')
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const moreLabel = pinsMoreLabel(total, expanded)

  function dismissApproval(id: string) {
    setDismissedApprovals((current) => new Set(current).add(id))
  }
  function dismissExchange(id: string) {
    setDismissedExchanges((current) => new Set(current).add(id))
  }

  return (
    <>
      <div
        id="bold-pins"
        className="bold-pins"
        data-expanded={expanded ? 'true' : 'false'}
        aria-label="Needs you"
      >
        <RoomApprovals
          approvals={needsApproval}
          messages={messages ?? []}
          jobs={jobs}
          selectedJob={selectedJob}
          agents={agents}
          dismissed={dismissedApprovals}
          report={report}
          onAnswered={dismissApproval}
        />
        <RoomExchanges
          jobs={cooking}
          agents={agents}
          dismissed={dismissedExchanges}
          report={report}
          onAnswered={dismissExchange}
        />
        <RunSafetyRequests jobs={recipeJobs} agents={agents} report={report} />
      </div>
      {moreLabel && (
        <button
          type="button"
          className="bold-pins-more"
          aria-expanded={expanded}
          aria-controls="bold-pins"
          onClick={() => setExpanded((open) => !open)}
        >
          {moreLabel}
          <ChevronIcon />
        </button>
      )}
    </>
  )
}
