import type { AgentSummary, Job } from '@score/contract'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { apiFetch, ApiError } from '../../data/api.ts'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { orchestrationsQuery } from '../../routes/orchestrations/orchestration-queries.ts'
import { RoomRunPanel } from '../../routes/orchestrations/RoomRunPanel.tsx'
import { statusLabel } from '../../routes/orchestrations/orch-model.ts'
import { briefHasRun } from '../../routes/runs/brief-run.ts'
import { workflowRunsQuery } from '../../routes/workflows/workflow-queries.ts'
import { WorkflowRoomPanel } from '../../routes/workflows/WorkflowRoomPanel.tsx'
import { boldRunLink } from '../bold-links.ts'
import { ReportBackLine } from '../room/ReportBack.tsx'
import { decisionError } from '../room/RoomRequests.tsx'
import { ThreadTasks } from '../room/RoomTasks.tsx'
import { jobExchangesQuery } from '../room/room-queries.ts'
import { exchangeStatus, jobStateLabel, needsYou } from '../room/room-model.ts'
import {
  currentExchange,
  type JobRecipe,
  recipeRun,
  recipeSummaryLine,
  threadTurns,
} from '../room/thread-model.ts'

// Ported from the deleted BoldThread (3.22.0 stage 2): the recipe run card.
function RecipeRunCard({ recipe, agents }: { recipe: JobRecipe; agents: AgentSummary[] }) {
  const orchestrations = useStreamQuery(orchestrationsQuery).data ?? []
  const workflows = useStreamQuery(workflowRunsQuery).data ?? []
  const [open, setOpen] = useState(false)
  const match = recipeRun(recipe, orchestrations, workflows)
  const runHref =
    match && briefHasRun(match.summary.briefId, orchestrations, workflows)
      ? boldRunLink(match.summary.briefId)
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

// Ported from the deleted BoldThread: Stop job with its confirm.
function StopTopic({ job, onStopped }: { job: Job; onStopped: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stopButton = useRef<HTMLButtonElement>(null)
  const keepGoing = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirming) keepGoing.current?.focus()
  }, [confirming])
  function cancel() {
    setConfirming(false)
    stopButton.current?.focus()
  }
  async function stop() {
    setStopping(true)
    setError(null)
    try {
      await apiFetch(`jobs/${encodeURIComponent(job.id)}/stop`, { method: 'POST', body: '{}' })
      setStatus('Stop sent.')
      setConfirming(false)
      onStopped()
    } catch (failure) {
      setError(
        failure instanceof ApiError && [401, 403, 409].includes(failure.status)
          ? decisionError(failure)
          : 'Couldn’t stop this job. Try again.',
      )
    } finally {
      setStopping(false)
    }
  }
  const finished = job.state === 'done' || job.state === 'closed'
  return (
    <>
      <button
        type="button"
        ref={stopButton}
        className="btn sm bold-thread-stop"
        disabled={finished || stopping}
        onClick={() => setConfirming(true)}
      >
        Stop
      </button>
      {confirming && (
        <div
          className="bold-thread-stop-confirm"
          data-protected="block"
          role="alertdialog"
          aria-label={`Stop ${job.title}?`}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            cancel()
          }}
        >
          <b>Stop “{job.title}”?</b>
          <span>
            Running steps are stopped. If Score can’t confirm a step ended, it asks you before going
            on.
          </span>
          <div className="bold-thread-confirm-actions">
            <button ref={keepGoing} type="button" className="btn sm ghost" onClick={cancel}>
              Keep going
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={stopping}
              onClick={() => void stop()}
            >
              {stopping ? 'Stopping…' : 'Stop job'}
            </button>
          </div>
        </div>
      )}
      {status && (
        <p className="bold-thread-status-line" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="bold-thread-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

/**
 * Info › This topic (3.22.0): what the deleted thread panel showed for the job the composer posts to, the live status
 * with its round and turns, the run or recipe, report-back, Hermes tasks and Stop. Step-in answers stay on the pause
 * card in the conversation (ExchangeRequestCard); the context meter and /compress live in the context bar.
 */
export function TopicInfo({
  roomId,
  job,
  agents,
}: {
  roomId: string
  job: Job
  agents: AgentSummary[]
}) {
  const definition = useMemo(() => jobExchangesQuery(job.id), [job.id])
  const exchanges = useStreamQuery(definition).data ?? []
  const refetch = useStreamQueryRefetch(definition)
  const current = currentExchange(exchanges)
  const waiting = current !== undefined && needsYou(current)
  const turns = threadTurns(current, job)
  const state = current ? exchangeStatus(current) : jobStateLabel(job)
  return (
    <section className="bold-topic-info" aria-labelledby="chat-info-topic">
      <h2 id="chat-info-topic" className="bold-chat-kicker">
        This topic
      </h2>
      <div className="bold-topic-head">
        <b className="bold-topic-title">{job.title}</b>
        <StopTopic job={job} onStopped={() => void refetch()} />
      </div>
      <p className="bold-topic-status">
        {waiting && (
          <span className="orch-pill" data-protected="inline">
            Needs you
          </span>
        )}
        <span>
          {state}
          {turns ? ` · ${turns}` : ''}
        </span>
      </p>
      <ReportBackLine job={job} inThread />
      {job.recipe && <RecipeRunCard recipe={job.recipe} agents={agents} />}
      <ThreadTasks roomId={roomId} agents={agents} />
    </section>
  )
}
