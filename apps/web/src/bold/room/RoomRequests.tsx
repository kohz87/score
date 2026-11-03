import type {
  AgentQuestion,
  AgentSummary,
  Approval,
  ApprovalChoice,
  Exchange,
  ExchangeOption,
  Job,
  Message,
} from '@score/contract'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { createPortal } from 'react-dom'
import { CHIP_MIN_HEIGHT, chipClearance, jumpTarget, type Jump } from './needs-jump.ts'
import { NeedsSlot, NeedsSlotsProvider, slotIds, useNeedsSlotsOuter } from './needs-slots.tsx'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch, ApiError } from '../../data/api.ts'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { questionsQuery, roomQuestions } from '../../data/question-queries.ts'
import {
  approvalOutcome,
  useApprovalDecision,
  whereToAnswer,
} from '../../routes/chat/ApprovalCard.tsx'
import { approvalsQuery } from '../../routes/chat/queries.ts'
import { useFence } from '../../routes/orchestrations/orchestration-queries.ts'
import { agentDisplayName, agentNameColor } from '../bold-agents.ts'
import { pairingProblem } from '../bold-errors.ts'
import {
  exchangePauseAsk,
  exchangePauseTitle,
  exchangeTurns,
  needsYou,
  optionLabel,
  approvalInRoom,
  approvalNeedsYou,
  reportBackWaiting,
} from './room-model.ts'
import { PinCard, PinsProvider, usePinRegistry } from './PinCards.tsx'
import { QuestionCard, useQuestionAnnouncement } from './QuestionCard.tsx'
import { reportBackText } from './ReportBack.tsx'
import { useReportBack } from './report-back-store.ts'
import { roomExchangesQuery, roomJobsQuery } from './room-queries.ts'
import { RoomTaskRequests } from './RoomTasks.tsx'
import { RunSafetyRequests } from './RunSafetyRequests.tsx'
import { useRoomNeedsYouState } from './use-needs-you.ts'

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
  const pairing = pairingProblem(failure)
  if (pairing) return pairing
  if (failure instanceof ApiError && failure.status === 409) return failure.message
  return 'Couldn’t send that decision. Try again.'
}

/** A restore or lost journal blocks every run: the room says so and opens the review that can lift it. */
function RoomFence() {
  const fence = useFence().data
  if (!fence?.fenced) return null
  return (
    <PinCard
      pinKey="global-fence"
      since={fence.since ?? ''}
      label="Starting work is blocked until you review the runs it stopped"
      variant="run-request"
    >
      <div className="bold-request-head">
        <b>Runs stopped</b>
      </div>
      <b className="bold-request-title">
        Starting work is blocked until you review the runs it stopped
      </b>
      <span>
        Score’s database and its separate record of what it started disagree. Nothing new starts
        until you review the list.
      </span>
      <div className="row">
        <Link className="btn sm" to="/b/settings/system#global-fence">
          Review the runs
        </Link>
      </div>
    </PinCard>
  )
}

function ReportBackRequestCard({ job, refetch }: { job: Job; refetch: () => void }) {
  const reportBack = job.reportBack
  const state = reportBack?.state
  const text = reportBack ? reportBackText(reportBack, job.source) : null
  const report = useReportBack(job.id, state ?? null, refetch)
  if (!reportBack || !text || (state !== 'needs_ok' && state !== 'not_confirmed')) return null
  return (
    <PinCard
      pinKey={`report-back:${job.id}`}
      since={job.updatedAt}
      label={`Report back: ${job.title}`}
      anchor={{ job: job.id }}
    >
      <div className="bold-request-head">
        <b>{job.title}</b>
        <span className="bold-request-job">{job.source?.ref ?? 'Trigger'}</span>
      </div>
      <b className="bold-request-title">{text}</b>
      <span>Score can send the result back when you allow it.</span>
      <span className="row wrap">
        <button
          type="button"
          className="btn sm"
          disabled={report.sending}
          onClick={() => void report.send()}
        >
          {report.sending ? 'Sending…' : state === 'needs_ok' ? 'Send' : 'Try again'}
        </button>
      </span>
      {report.stillSending && (
        <span className="bold-report-back-note">Still sending — check the source</span>
      )}
      {report.error && (
        <span className="bold-request-error" role="alert">
          {report.error}
        </span>
      )}
    </PinCard>
  )
}

function RoomReportBacks({ roomId, jobs }: { roomId: string; jobs: Job[] }) {
  const jobsDefinition = useMemo(() => roomJobsQuery(roomId), [roomId])
  const refetch = useStreamQueryRefetch(jobsDefinition)
  // A closed job asks nothing (reopen it to send its result back); the reads include closed jobs.
  const waiting = reportBackWaiting(jobs)
  return (
    <>
      {waiting.map((job) => (
        <ReportBackRequestCard key={job.id} job={job} refetch={refetch} />
      ))}
    </>
  )
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
  const [sent, setSent] = useState<{ pause: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const options = exchange.pause?.options ?? []
  // The decision is applied (and the limits re-checked) in one server transaction that writes the exchange once, so any
  // later read has a newer updatedAt: either the pause is gone (the card leaves) or it was held again (the buttons come
  // back, even with the same reason and options). Until then the "sent" line stays.
  const pauseIdentity = exchange.pause ? `${exchange.id}|${exchange.updatedAt}` : null
  const sentMatchesPause = sent !== null && sent.pause === pauseIdentity
  if (sent !== null && !sentMatchesPause) setSent(null)
  const sentText = sentMatchesPause ? sent.text : null
  const reassignChoices = agents.filter(
    (agent) => agent.id !== exchange.from && agent.id !== exchange.to,
  )
  // Reassign never starts on the agent who has the turn (`exchange.to`): the first legal choice is the pick.
  const [form, setForm] = useState({
    note: '',
    text: '',
    agent: '',
    usd: '10',
    turns: '4',
  })

  async function choose(option: ExchangeOption) {
    if (needsForm(option)) {
      if (option === 'reassign')
        setForm((current) => ({ ...current, agent: reassignChoices[0]?.id ?? '' }))
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
    if (option === 'more_spend' && (!Number.isFinite(usd) || usd <= 0 || usd > 1000))
      return setError('Enter an amount above 0 and at most 1000 dollars.')
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`exchanges/${encodeURIComponent(exchange.id)}/decision`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (pauseIdentity !== null)
        setSent({
          pause: pauseIdentity,
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
      anchor={{ job: job.id }}
    >
      <div className="bold-request-head">
        {from && <AgentGlyph agent={from} size="xs" decorative mood="needs" />}
        <b style={from ? { color: agentNameColor(from) } : undefined}>
          {from ? agentDisplayName(from) : exchange.from}
        </b>
        {to && (
          <>
            <span className="muted">with</span>
            <b style={{ color: agentNameColor(to) }}>{agentDisplayName(to)}</b>
          </>
        )}
        <span className="bold-request-job">{job.title}</span>
      </div>
      <b className="bold-request-title">{exchangePauseTitle(exchange)}</b>
      <span>{exchangePauseAsk(exchange)}</span>
      {exchange.pause?.droppedAgents?.length ? (
        <span className="small">
          Also held back while this waits:{' '}
          {exchange.pause.droppedAgents
            .map((id) => {
              const agent = agents.find((item) => item.id === id)
              return agent ? agentDisplayName(agent) : id
            })
            .join(', ')}
          . Their turns were dropped; ask them again once this is settled.
        </span>
      ) : null}
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
                    {agentDisplayName(agent)}
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
                max="1000"
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
                  ? form.turns.trim()
                    ? `Give ${form.turns} more turns`
                    : 'Give more turns'
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

function RoomExchanges({ jobs, agents }: { jobs: Job[]; agents: AgentSummary[] }) {
  const definition = useMemo(() => roomExchangesQuery(jobs.map((job) => job.id)), [jobs])
  const exchanges = useStreamQuery(definition).data ?? []
  const refetch = useStreamQueryRefetch(definition)
  const visible = exchanges.filter(needsYou)
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
        {agent && <AgentGlyph agent={agent} size="xs" decorative mood="needs" />}
        <b style={agent ? { color: agentNameColor(agent) } : undefined}>
          {agent ? agentDisplayName(agent) : current.agentId}
        </b>
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

function RoomApprovals({
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

function RoomQuestions({
  questions,
  jobs,
  agents,
}: {
  questions: AgentQuestion[]
  jobs: Job[]
  agents: AgentSummary[]
}) {
  return (
    <>
      {questions.map((question) => (
        <QuestionCard
          key={question.id}
          question={question}
          agent={agents.find((item) => item.id === question.agentId)}
          jobTitle={jobs.find((item) => item.id === question.jobId)?.title}
        />
      ))}
    </>
  )
}

/**
 * 3.24.0: the chip above the composer that says a card needs you out of view and takes you to the nearest one.
 * It lives in the stream's `chip` slot (nothing is drawn where no conversation is, the cards are then in plain view).
 */
function NeedsJumpChip({ cardKeys }: { cardKeys: string[] }) {
  const slots = useNeedsSlotsOuter()
  const slot = slots?.elements.get(slotIds.chip) ?? null
  const [jump, setJump] = useState<Jump | null>(null)
  const chipRef = useRef<HTMLButtonElement | null>(null)
  const clearance = useRef(chipClearance(CHIP_MIN_HEIGHT))
  const measure = useCallback(() => {
    const scroller = document.getElementById('bold-room-stream')
    if (!scroller) return setJump(null)
    const view = scroller.getBoundingClientRect()
    // A card that takes no room (display: none, hidden) is neither counted nor a place to take the person to.
    const cards = [...scroller.querySelectorAll<HTMLElement>('[data-pin-key]')].flatMap((card) => {
      const rect = card.getBoundingClientRect()
      if (rect.height === 0) return []
      return [{ key: card.getAttribute('data-pin-key') ?? '', top: rect.top, bottom: rect.bottom }]
    })
    const next = jumpTarget({ top: view.top, bottom: view.bottom }, cards, clearance.current)
    setJump((previous) =>
      previous?.key === next?.key &&
      previous?.count === next?.count &&
      previous?.direction === next?.direction
        ? previous
        : next,
    )
  }, [])
  useEffect(() => {
    const scroller = document.getElementById('bold-room-stream')
    if (!scroller) return
    const first = requestAnimationFrame(measure)
    scroller.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(scroller)
    const mutations =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => measure())
    mutations?.observe(scroller, { childList: true, subtree: true })
    return () => {
      cancelAnimationFrame(first)
      scroller.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      observer?.disconnect()
      mutations?.disconnect()
    }
  }, [cardKeys.length, measure, slot])
  const showing = jump !== null && slot !== null
  // While any card waits, the stream keeps its bottom clear of the chip, so it never sits on a card's buttons. Keyed on
  // a card waiting, not on the chip showing: the padding moves the cards, so tying it to the chip made the two switch
  // each other on and off at the stream's end (3.24.0 review).
  const pending = cardKeys.length > 0 && slot !== null
  useLayoutEffect(() => {
    const scroller = document.getElementById('bold-room-stream')
    if (!scroller || !pending) return
    const height = chipRef.current?.getBoundingClientRect().height ?? 0
    const needed = chipClearance(height)
    if (needed !== clearance.current) {
      clearance.current = needed
      measure()
    }
    scroller.style.paddingBottom = `${needed + 4}px`
    scroller.style.scrollPaddingBottom = `${needed}px`
    return () => {
      scroller.style.paddingBottom = ''
      scroller.style.scrollPaddingBottom = ''
    }
  }, [pending, showing, jump?.count, measure])
  if (!jump || !slot) return null
  const go = () => {
    const card = document.querySelector<HTMLElement>(`[data-pin-key=${JSON.stringify(jump.key)}]`)
    if (!card) return
    card.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    card.focus({ preventScroll: true })
  }
  const arrow = jump.direction === 'up' ? '↑' : '↓'
  return createPortal(
    <button
      ref={chipRef}
      type="button"
      className="bold-needs-jump"
      data-protected="inline-flex"
      aria-label={`${jump.count} ${jump.count === 1 ? 'card needs' : 'cards need'} you, ${jump.direction === 'up' ? 'above' : 'below'}. Go to the nearest.`}
      onClick={go}
    >
      {jump.count} {jump.count === 1 ? 'needs' : 'need'} you {arrow}
    </button>,
    slot,
  )
}

/**
 * 3.24.0: the needs-you cards are drawn inside the conversation (see needs-slots.tsx), after the message that asked.
 * This component owns the reads, the announcements and the focus hand-off, and renders the cards into their slots.
 */
export function RoomRequests(props: Parameters<typeof RoomRequestsInner>[0]) {
  // Alone (no stream around it) the cards fall back to a plain list in place.
  const outer = useNeedsSlotsOuter()
  return outer ? (
    <RoomRequestsInner {...props} />
  ) : (
    <NeedsSlotsProvider>
      <RoomRequestsInner {...props} />
    </NeedsSlotsProvider>
  )
}

function RoomRequestsInner({
  roomId,
  jobs,
  agents,
  messages,
  selectedJob,
  teamRoom = false,
}: {
  roomId: string
  jobs: Job[]
  agents: AgentSummary[]
  messages?: Message[]
  selectedJob: string
  teamRoom?: boolean
}) {
  const approvals = useStreamQuery(approvalsQuery).data ?? []
  const pins = usePinRegistry()
  const focusedKey = useRef<string | null>(null)
  const lastCards = useRef<typeof pins.cards>([])
  const lastVisible = useRef<string[]>([])
  const trackFocus = useCallback((key: string) => {
    focusedKey.current = key
  }, [])
  const selectedJobs = jobs.filter(
    (job) => job.state !== 'closed' && (selectedJob === 'all' || job.id === selectedJob),
  )
  const cooking = selectedJobs.filter(
    (job) => job.state === 'waiting_on_you' || job.state === 'working',
  )
  const recipeJobs = selectedJobs.filter((job) => job.recipe !== null)
  const needsApproval = approvals.filter(approvalNeedsYou)
  const needs = useRoomNeedsYouState({ roomId, jobs, messages, selectedJob, teamRoom })
  const questionsRead = useStreamQuery(questionsQuery)
  const questions = roomQuestions(questionsRead.data ?? [], roomId, teamRoom, selectedJob)
  const total = needs.total
  // Questions announce in their own sentence; the count sentence covers the rest.
  const countedTotal = total - needs.questionCount
  const questionAnnouncement = useQuestionAnnouncement(
    questions,
    questionsRead.status === 'success',
    agents,
  )
  const lastTotal = useRef<number | null>(null)
  const settled = useRef(false)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    if (!needs.ready) return
    if (!settled.current) {
      settled.current = true
      lastTotal.current = countedTotal
      return
    }
    // A status region only announces text that changes. Clear it when the count falls, so the same text can announce
    // again on the next rise (2 → 1 → 2).
    if (countedTotal < (lastTotal.current ?? 0)) setAnnouncement('')
    else if (countedTotal > (lastTotal.current ?? 0)) setAnnouncement(`${total} need you`)
    lastTotal.current = countedTotal
  }, [needs.ready, countedTotal, total])

  // A card that goes takes the focus with it: the next card (or the composer) gets it instead.
  useEffect(() => {
    const visible = pins.cards.map((card) => card.key)
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
          : document.querySelector<HTMLElement>('.bold-room-composer textarea')
        target?.focus()
        focusedKey.current = null
      }
    }
    lastCards.current = pins.cards
    lastVisible.current = visible
  }, [pins.cards])

  return (
    <PinsProvider value={pins.value}>
      {/* The status node stays mounted at zero so its first 0 → 1 change is announced. */}
      <span className="bold-sr-only" role="status">
        {announcement}
      </span>
      {/* Its own region, so a question never hides the "N need you" (or the other way round). */}
      <span className="bold-sr-only" role="status">
        {questionAnnouncement}
      </span>
      {/* Where no conversation is drawn (an empty room, still loading) the cards sit here, in plain view. */}
      <NeedsSlot id={slotIds.fallback} className="bold-needs-fallback" />
      <NeedsFocusTracker onFocusKey={trackFocus} />
      {total > 0 && (
        <>
          <RoomFence />
          <RoomApprovals
            roomId={roomId}
            approvals={needsApproval}
            messages={messages ?? []}
            jobs={jobs}
            selectedJob={selectedJob}
            agents={agents}
          />
          <RoomQuestions questions={questions} jobs={jobs} agents={agents} />
          <RoomExchanges jobs={cooking} agents={agents} />
          <RoomReportBacks roomId={roomId} jobs={jobs} />
          <RunSafetyRequests jobs={recipeJobs} agents={agents} />
          <RoomTaskRequests roomId={roomId} agents={agents} teamRoom={teamRoom} />
          <NeedsJumpChip cardKeys={pins.cards.map((card) => card.key)} />
        </>
      )}
    </PinsProvider>
  )
}

/** Cards live in the stream, outside this component's tree: focus inside any of them is tracked from the document. */
function NeedsFocusTracker({ onFocusKey }: { onFocusKey: (key: string) => void }) {
  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      const key =
        event.target instanceof Element
          ? event.target.closest('[data-pin-key]')?.getAttribute('data-pin-key')
          : null
      if (key) onFocusKey(key)
    }
    document.addEventListener('focusin', onFocus)
    return () => document.removeEventListener('focusin', onFocus)
  }, [onFocusKey])
  return null
}
