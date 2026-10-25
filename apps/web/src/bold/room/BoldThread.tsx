import {
  MessagePageSchema,
  type AgentSummary,
  type Exchange,
  type Job,
  type Message,
} from '@score/contract'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { apiFetch, ApiError } from '../../data/api.ts'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { MessageItem } from '../../routes/chat/MessageItem.tsx'
import { ContextMeter } from '../../routes/chat/ContextMeter.tsx'
import { orchestrationsQuery } from '../../routes/orchestrations/orchestration-queries.ts'
import { RoomRunPanel } from '../../routes/orchestrations/RoomRunPanel.tsx'
import { statusLabel } from '../../routes/orchestrations/orch-model.ts'
import { briefHasRun } from '../../routes/runs/brief-run.ts'
import { workflowRunsQuery } from '../../routes/workflows/workflow-queries.ts'
import { WorkflowRoomPanel } from '../../routes/workflows/WorkflowRoomPanel.tsx'
import { agentsQuery } from '../../routes/chat/queries.ts'
import { ChevronIcon } from '../BoldIcons.tsx'
import { agentDisplayName } from '../bold-agents.ts'
import { exchangeStatus, jobStateLabel, needsYou } from './room-model.ts'
import {
  currentExchange,
  type JobRecipe,
  jobSessionId,
  recipeRun,
  recipeSummaryLine,
  threadRounds,
  threadTurns,
} from './thread-model.ts'
import { decisionError, ExchangeRequestCard } from './RoomRequests.tsx'
import { ReportBackLine } from './ReportBack.tsx'
import { ThreadTasks } from './RoomTasks.tsx'
import {
  jobExchangesQuery,
  roomJobsQuery,
  roomMessagesQuery,
  teamRoomQuery,
} from './room-queries.ts'
import type { MessagePageData } from '../../routes/chat/queries.ts'
import './bold-thread.css'

function SendIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  )
}

function ThreadLoading({ text }: { text: string }) {
  return (
    <div className="sidebody bold-thread" role="status">
      <p className="bold-thread-note">{text}</p>
    </div>
  )
}

function ThreadUnavailable({ failed }: { failed: boolean }) {
  return (
    <div className="sidebody bold-thread" role={failed ? 'alert' : 'status'}>
      <p className="bold-thread-note">
        {failed ? 'Couldn’t open the thread.' : 'This thread isn’t ready yet.'}
      </p>
    </div>
  )
}

function JobPicker({ jobs, onPick }: { jobs: Job[]; onPick: (jobId: string) => void }) {
  const named = jobs.filter((job) => !job.isDefault)
  return (
    <div className="sidebody bold-thread">
      <div className="bold-thread-head">
        <div>
          <h2>Thread</h2>
          <span className="bold-thread-status">A job’s back-and-forth</span>
        </div>
      </div>
      <div className="bold-thread-picker">
        {named.map((job) => (
          <button key={job.id} type="button" onClick={() => onPick(job.id)}>
            <span>{job.title}</span>
            <span className="small muted">{jobStateLabel(job)}</span>
            <ChevronIcon />
          </button>
        ))}
        {named.length === 0 && <p className="bold-thread-note">There are no jobs to open yet.</p>}
      </div>
    </div>
  )
}

// The thread shows an approval's real card, not the room stream's pointer: the strip may be filtered to another job or
// covered by the phone sheet. A second answer from the strip gets the server's 409, explained there.
function ThreadMessage({ message, agents }: { message: Message; agents: AgentSummary[] }) {
  return (
    <div className="bold-message bold-thread-message" data-message-id={message.id}>
      <MessageItem message={message} agents={agents} />
    </div>
  )
}

function RecipeRunCard({ recipe, agents }: { recipe: JobRecipe; agents: AgentSummary[] }) {
  const orchestrations = useStreamQuery(orchestrationsQuery).data ?? []
  const workflows = useStreamQuery(workflowRunsQuery).data ?? []
  const [open, setOpen] = useState(false)
  const match = recipeRun(recipe, orchestrations, workflows)
  const runHref =
    match && briefHasRun(match.summary.briefId, orchestrations, workflows)
      ? `/runs/${encodeURIComponent(match.summary.briefId)}`
      : null
  const title =
    match?.summary.title ?? (recipe.kind === 'workflow' ? 'Workflow run' : 'Orchestration')
  const kind = recipe.kind === 'workflow' ? 'Workflow run' : 'Orchestration'
  const status = match ? statusLabel[match.summary.status] : null
  return (
    <section className="bold-thread-recipe" aria-label="Recipe run">
      <div className="bold-thread-recipe-head">
        <span className="bold-thread-eyebrow">{kind}</span>
        <b>{title}</b>
        {status && <span className="bold-thread-recipe-status">{status}</span>}
        {match && match.summary.needsYou.length > 0 && (
          <span className="orch-pill" data-protected="inline">
            Needs you ({match.summary.needsYou.length})
          </span>
        )}
      </div>
      {match ? (
        <>
          <span className="small muted">{recipeSummaryLine(match)}</span>
          <div className="bold-thread-recipe-actions">
            <button type="button" className="btn sm" onClick={() => setOpen((value) => !value)}>
              {open ? 'Hide plan and steps' : 'Show plan and steps'}
            </button>
            {runHref && (
              <Link className="bold-thread-link" to={runHref}>
                Open the run
              </Link>
            )}
          </div>
          {open &&
            (match.kind === 'orchestration' ? (
              <RoomRunPanel summary={match.summary} agents={agents} />
            ) : (
              <WorkflowRoomPanel summary={match.summary} agents={agents} />
            ))}
        </>
      ) : (
        <span className="small muted">
          This job links to {recipe.kind} {recipe.ref}, which isn’t in the run list.
        </span>
      )}
    </section>
  )
}

function ThreadComposer({
  roomId,
  job,
  paused,
  onSent,
}: {
  roomId: string
  job: Job
  paused: Exchange | undefined
  onSent: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stepInExchange = paused?.pause?.options.includes('step_in') ? paused : undefined
  const closed = job.state === 'done' || job.state === 'closed'
  async function send(event: FormEvent) {
    event.preventDefault()
    const value = text.trim()
    if (!value || busy || closed) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      if (stepInExchange) {
        await apiFetch(`exchanges/${encodeURIComponent(stepInExchange.id)}/decision`, {
          method: 'POST',
          body: JSON.stringify({ option: 'step_in', text: value }),
        })
      } else {
        await apiFetch(`rooms/${encodeURIComponent(roomId)}/messages`, {
          method: 'POST',
          body: JSON.stringify({ text: value, jobId: job.id }),
        })
      }
      setText('')
      setStatus(stepInExchange ? 'Step in sent.' : 'Message sent.')
      onSent()
    } catch (failure) {
      setError(decisionError(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="bold-thread-foot">
      <form className="bold-thread-composer" onSubmit={(event) => void send(event)}>
        <label className="chat-sr-only" htmlFor="bold-thread-stepin">
          Step in
        </label>
        <input
          id="bold-thread-stepin"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={`Step in: write to everyone in ${job.title}`}
          autoComplete="off"
          disabled={closed}
        />
        <button
          type="submit"
          className="bold-thread-send"
          aria-label="Send step-in"
          disabled={!text.trim() || busy || closed}
        >
          <SendIcon />
        </button>
      </form>
      {status && (
        <p className="bold-thread-composer-status" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="bold-thread-composer-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function JobThread({
  roomId,
  job,
  jobs,
  agents,
}: {
  roomId: string
  job: Job
  jobs: Job[]
  agents: AgentSummary[]
}) {
  const exchangesDefinition = useMemo(() => jobExchangesQuery(job.id), [job.id])
  const exchanges = useStreamQuery(exchangesDefinition).data ?? []
  const defaultJobId = jobs.find((item) => item.isDefault)?.id ?? null
  const messagesDefinition = useMemo(
    () => roomMessagesQuery(roomId, job.id, null, defaultJobId),
    [defaultJobId, job.id, roomId],
  )
  const messagesState = useStreamQuery(messagesDefinition)
  const [olderPages, setOlderPages] = useState<MessagePageData[]>([])
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [confirmingStop, setConfirmingStop] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopStatus, setStopStatus] = useState<string | null>(null)
  const [stopError, setStopError] = useState<string | null>(null)
  const refetchExchanges = useStreamQueryRefetch(exchangesDefinition)
  const stopButton = useRef<HTMLButtonElement>(null)
  const keepGoing = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirmingStop) keepGoing.current?.focus()
  }, [confirmingStop])
  function cancelStop() {
    setConfirmingStop(false)
    stopButton.current?.focus()
  }
  const current = currentExchange(exchanges)
  const paused = current && current.pause && needsYou(current) ? current : undefined
  const holder = agents.find((agent) => agent.id === job.holderAgentId)
  const allMessages = useMemo(() => {
    const byId = new Map<string, Message>()
    for (const page of olderPages) for (const message of page.items) byId.set(message.id, message)
    for (const message of messagesState.data?.items ?? []) byId.set(message.id, message)
    return [...byId.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
  }, [messagesState.data, olderPages])
  const olderCursor = olderPages.at(-1)?.nextCursor ?? messagesState.data?.nextCursor ?? null
  const reviewExchanges = exchanges.filter((item) => item.kind === 'review').length
  const rounds = useMemo(
    () =>
      threadRounds(allMessages, {
        hasEarlier: olderCursor !== null,
        reviewExchanges,
      }),
    [allMessages, reviewExchanges, olderCursor],
  )
  const finishedReplies = allMessages.filter(
    (message) => message.author.kind === 'agent' && !message.streaming,
  ).length

  async function loadOlder() {
    if (!olderCursor || loadingOlder) return
    setLoadingOlder(true)
    setHistoryError(null)
    try {
      const params = new URLSearchParams({ limit: '50', jobId: job.id, before: olderCursor })
      const page = MessagePageSchema.parse(
        await apiFetch(`rooms/${encodeURIComponent(roomId)}/messages?${params}`),
      )
      setOlderPages((pages) => [...pages, { ...page, typing: {} }])
    } catch {
      setHistoryError('Couldn’t load earlier messages.')
    } finally {
      setLoadingOlder(false)
    }
  }

  async function stopJob() {
    setStopping(true)
    setStopError(null)
    try {
      await apiFetch(`jobs/${encodeURIComponent(job.id)}/stop`, { method: 'POST', body: '{}' })
      setStopStatus('Stop sent.')
      setConfirmingStop(false)
      void refetchExchanges()
    } catch (failure) {
      setStopError(
        failure instanceof ApiError && [401, 403, 409].includes(failure.status)
          ? decisionError(failure)
          : 'Couldn’t stop this job. Try again.',
      )
    } finally {
      setStopping(false)
    }
  }

  const turnText = threadTurns(current, job)
  const stateText = current ? exchangeStatus(current).replace(/^round \d+ · /, '') : null
  const stopDisabled = job.state === 'done' || job.state === 'closed' || stopping

  return (
    <>
      <div className="sidebody bold-thread">
        <div className="bold-thread-head">
          <div className="bold-thread-title">
            <h2>{job.title}</h2>
            <span className="bold-thread-status">
              {turnText ?? jobStateLabel(job)}
              {stateText ? ` · ${stateText}` : ''}
            </span>
          </div>
          <div className="bold-thread-actions">
            {holder && (
              <ContextMeter
                roomId={roomId}
                agentId={holder.id}
                name={agentDisplayName(holder)}
                sessionId={jobSessionId(roomId, job, holder.id)}
                finishedReplies={finishedReplies}
              />
            )}
            <button
              type="button"
              ref={stopButton}
              className="btn sm bold-thread-stop"
              disabled={stopDisabled}
              onClick={() => setConfirmingStop(true)}
            >
              Stop
            </button>
          </div>
        </div>

        <ReportBackLine job={job} inThread />

        <ThreadTasks roomId={roomId} agents={agents} />

        {confirmingStop && (
          <div
            className="bold-thread-stop-confirm"
            data-protected="block"
            role="alertdialog"
            aria-label={`Stop ${job.title}?`}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              cancelStop()
            }}
          >
            <b>Stop “{job.title}”?</b>
            <span>
              Running steps are stopped. If Score can’t confirm a step ended, it asks you before
              going on.
            </span>
            <div className="bold-thread-confirm-actions">
              <button ref={keepGoing} type="button" className="btn sm ghost" onClick={cancelStop}>
                Keep going
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={stopping}
                onClick={() => void stopJob()}
              >
                {stopping ? 'Stopping…' : 'Stop job'}
              </button>
            </div>
          </div>
        )}
        {stopStatus && (
          <p className="bold-thread-status-line" role="status">
            {stopStatus}
          </p>
        )}
        {stopError && (
          <p className="bold-thread-error" role="alert">
            {stopError}
          </p>
        )}

        {job.recipe && <RecipeRunCard recipe={job.recipe} agents={agents} />}

        <div className="bold-thread-messages" aria-label="Job thread">
          {messagesState.status === 'pending' && (
            <p className="bold-thread-note" role="status">
              Loading the thread…
            </p>
          )}
          {messagesState.status === 'error' && (
            <p className="bold-thread-note" role="alert">
              Couldn’t load this thread. Try again.
            </p>
          )}
          {messagesState.status === 'success' && rounds.length === 0 && (
            <p className="bold-thread-note">Nothing here yet. Write below to step in.</p>
          )}
          {olderCursor && (
            <button
              type="button"
              className="bold-thread-history"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
            >
              {loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </button>
          )}
          {historyError && (
            <p className="bold-thread-error" role="alert">
              {historyError}
            </p>
          )}
          {rounds.map((round) => (
            <section
              key={round.key}
              className="bold-thread-round"
              aria-label={`${round.label} messages`}
            >
              <h3 className="bold-thread-round-label">{round.label}</h3>
              {round.messages.map((message) => (
                <ThreadMessage key={message.id} message={message} agents={agents} />
              ))}
            </section>
          ))}
        </div>

        {paused && (
          <ExchangeRequestCard key={paused.id} exchange={paused} job={job} agents={agents} />
        )}
      </div>
      <ThreadComposer
        roomId={roomId}
        job={job}
        paused={paused}
        onSent={() => void refetchExchanges()}
      />
    </>
  )
}

function ThreadRoom({
  roomId,
  jobId,
  jobs,
  agents,
  onSelectJob,
}: {
  roomId: string
  jobId: string | null
  jobs: Job[]
  agents: AgentSummary[]
  onSelectJob: (jobId: string) => void
}) {
  const target = jobId
  const job = target ? jobs.find((item) => item.id === target) : undefined
  if (!target) return <JobPicker jobs={jobs} onPick={onSelectJob} />
  if (!job)
    return (
      <div className="sidebody bold-thread">
        <p className="bold-thread-note">This job no longer exists.</p>
      </div>
    )
  return <JobThread key={job.id} roomId={roomId} job={job} jobs={jobs} agents={agents} />
}

/** A job's thread in the side panel: rounds, the live messages, the pause card and the step-in composer. */
export function BoldThread({
  jobId,
  onSelectJob,
}: {
  jobId: string | null
  onSelectJob: (jobId: string) => void
}) {
  const location = useLocation()
  const override = new URLSearchParams(location.search).get('room')
  const roomDefinition = useMemo(() => teamRoomQuery(override), [override])
  const roomState = useStreamQuery(roomDefinition)
  const agents = useStreamQuery(agentsQuery).data ?? []
  if (roomState.status === 'pending') return <ThreadLoading text="Loading the thread…" />
  if (roomState.status === 'error' || !roomState.data)
    return <ThreadUnavailable failed={roomState.status === 'error'} />
  return (
    <ThreadJobs
      roomId={roomState.data.room.id}
      jobId={jobId}
      agents={agents}
      onSelectJob={onSelectJob}
    />
  )
}

function ThreadJobs({
  roomId,
  jobId,
  agents,
  onSelectJob,
}: {
  roomId: string
  jobId: string | null
  agents: AgentSummary[]
  onSelectJob: (jobId: string) => void
}) {
  const jobsDefinition = useMemo(() => roomJobsQuery(roomId), [roomId])
  const jobsState = useStreamQuery(jobsDefinition)
  const jobs = jobsState.data ?? []
  if (jobsState.status === 'pending') return <ThreadLoading text="Loading jobs…" />
  if (jobsState.status === 'error') return <ThreadUnavailable failed />
  return (
    <ThreadRoom
      roomId={roomId}
      jobId={jobId}
      jobs={jobs}
      agents={agents}
      onSelectJob={onSelectJob}
    />
  )
}
