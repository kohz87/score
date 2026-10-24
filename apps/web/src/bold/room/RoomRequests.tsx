import type {
  AgentSummary,
  Approval,
  ApprovalChoice,
  Exchange,
  ExchangeOption,
  Job,
  Message,
} from '@score/contract'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch, ApiError } from '../../data/api.ts'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
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
  approvalNeedsYou,
} from './room-model.ts'
import { PinCard, PinsProvider, usePinRegistry } from './PinCards.tsx'
import { roomExchangesQuery } from './room-queries.ts'
import { RunSafetyRequests, type CountCards } from './RunSafetyRequests.tsx'

type PendingOption = ExchangeOption | null

function decisionBody(
  option: ExchangeOption,
  form: { note: string; text: string; agent: string; usd: string; turns: string },
) {
  switch (option) {
    case 'more_turns':
      return { option, turns: Number(form.turns) }
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
  return ['more_turns', 'more_spend', 'step_in', 'reassign', 'send_back'].includes(option)
}

export function decisionError(failure: unknown): string {
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

export function ExchangeRequestCard({
  exchange,
  job,
  agents,
  onAnswered,
}: {
  exchange: Exchange
  job: Job
  agents: AgentSummary[]
  onAnswered?: () => void
}) {
  const from = agents.find((agent) => agent.id === exchange.from)
  const to = agents.find((agent) => agent.id === exchange.to)
  const [pending, setPending] = useState<PendingOption>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<{ pauseKey: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pauseKey = `${exchange.updatedAt}:${exchange.pause?.reason ?? ''}:${exchange.pause?.options.join(',') ?? ''}`
  const sentText = sent?.pauseKey === pauseKey ? sent.text : null
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
    turns: '4',
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
    const turns = 'turns' in body ? body.turns : undefined
    if (
      option === 'more_turns' &&
      !(typeof turns === 'number' && Number.isInteger(turns) && turns >= 1 && turns <= 20)
    )
      return setError('Choose between 1 and 20 turns.')
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
      setSent({
        pauseKey,
        text: option === 'send_back' ? 'Sent back with your note.' : 'Decision sent.',
      })
      setPending(null)
      onAnswered?.()
    } catch (failure) {
      setError(decisionError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PinCard
      pinKey={`exchange:${exchange.id}`}
      since={exchange.updatedAt}
      label={exchangePauseTitle(exchange)}
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
          {pending === 'more_turns' && (
            <label>
              More turns (1–20)
              <input
                type="number"
                min="1"
                max="20"
                step="1"
                value={form.turns}
                onChange={(event) => setForm({ ...form, turns: event.target.value })}
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
              {busy
                ? 'Sending…'
                : pending === 'more_turns'
                  ? `Give ${form.turns} more turns`
                  : optionLabel(pending)}
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

      {pending === null && !sentText && (
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
      {sentText && (
        <span className="bold-request-sent" role="status">
          {sentText}
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

function RoomExchanges({
  jobs,
  agents,
  report,
}: {
  jobs: Job[]
  agents: AgentSummary[]
  report: CountCards
}) {
  const definition = useMemo(() => roomExchangesQuery(jobs.map((job) => job.id)), [jobs])
  const exchanges = useStreamQuery(definition).data ?? []
  const refetch = useStreamQueryRefetch(definition)
  const visible = exchanges.filter(needsYou)
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
            onAnswered={() => void refetch()}
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
}: {
  approval: Approval
  job: Job | undefined
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
      if (event.key !== 'Escape') return
      event.preventDefault()
      setMore(false)
      requestAnimationFrame(() => moreButton.current?.focus())
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
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
                      Always allow for {current.agentId}
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

function RoomApprovals({
  approvals,
  messages,
  jobs,
  selectedJob,
  agents,
  report,
}: {
  approvals: Approval[]
  messages: Message[]
  jobs: Job[]
  selectedJob: string
  agents: AgentSummary[]
  report: CountCards
}) {
  const cards = approvals.flatMap((approval) => {
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
        <ApprovalRequestCard key={approval.id} approval={approval} job={job} agents={agents} />
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
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [expanded, setExpanded] = useState(false)
  const pins = usePinRegistry()
  const heading = useRef<HTMLHeadingElement>(null)
  const focusedKey = useRef<string | null>(null)
  const lastCards = useRef<typeof pins.cards>([])
  const lastVisible = useRef<string[]>([])
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
  const needsApproval = approvals.filter(approvalNeedsYou)
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const moreLabel = pinsMoreLabel(total, expanded)

  // With one card or none left the strip folds, so the next burst of cards doesn't arrive already expanded.
  if (expanded && total <= 1) setExpanded(false)

  // A card that goes takes the focus with it: the next card (or the strip's heading) gets it instead.
  useEffect(() => {
    const visible = pins.cards.filter((_, index) => expanded || index === 0).map((card) => card.key)
    const lost = lastVisible.current.find((key) => !visible.includes(key))
    if (lost && focusedKey.current === lost) {
      const active = document.activeElement
      const activeKey =
        active instanceof Element
          ? active.closest('[data-pin-key]')?.getAttribute('data-pin-key')
          : null
      if (!activeKey || activeKey === lost) {
        const lostIndex = lastCards.current.findIndex((card) => card.key === lost)
        const ordered = pins.cards.filter((card) => visible.includes(card.key))
        const next = ordered[Math.min(Math.max(lostIndex, 0), ordered.length - 1)]
        const target = next
          ? document.querySelector<HTMLElement>(`[data-pin-key=${JSON.stringify(next.key)}]`)
          : null
        ;(target ?? heading.current)?.focus()
        focusedKey.current = null
      }
    }
    lastCards.current = pins.cards
    lastVisible.current = visible
  }, [expanded, pins.cards])

  return (
    <PinsProvider value={pins.value}>
      <div
        id="bold-pins"
        className="bold-pins"
        data-expanded={expanded ? 'true' : 'false'}
        aria-label="Needs you"
        onFocusCapture={(event) => {
          focusedKey.current =
            (event.target as Element).closest('[data-pin-key]')?.getAttribute('data-pin-key') ??
            focusedKey.current
        }}
      >
        <h2 ref={heading} className="bold-pins-title" tabIndex={-1}>
          Needs you
        </h2>
        <RoomApprovals
          approvals={needsApproval}
          messages={messages ?? []}
          jobs={jobs}
          selectedJob={selectedJob}
          agents={agents}
          report={report}
        />
        <RoomExchanges jobs={cooking} agents={agents} report={report} />
        <RunSafetyRequests jobs={recipeJobs} agents={agents} report={report} />
      </div>
      {moreLabel && (
        <button
          type="button"
          className="bold-pins-more"
          data-protected="inline-flex"
          aria-expanded={expanded}
          aria-controls="bold-pins"
          aria-live="polite"
          onClick={() => setExpanded((open) => !open)}
        >
          {moreLabel}
          <ChevronIcon />
        </button>
      )}
    </PinsProvider>
  )
}
