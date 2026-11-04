import type { AgentSummary, Job } from '@score/contract'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { orchestrationsQuery } from '../../routes/orchestrations/orchestration-queries.ts'
import { RoomRunPanel } from '../../routes/orchestrations/RoomRunPanel.tsx'
import { statusLabel } from '../../routes/orchestrations/orch-model.ts'
import { briefHasRun } from '../../routes/runs/brief-run.ts'
import { workflowRunsQuery } from '../../routes/workflows/workflow-queries.ts'
import { WorkflowRoomPanel } from '../../routes/workflows/WorkflowRoomPanel.tsx'
import { boldRunLink } from '../bold-links.ts'
import { InfoSection } from './InfoSection.tsx'
import { ReportBackLine } from '../room/ReportBack.tsx'
import { useStopJob } from '../room/StopJob.tsx'
import { ThreadTasks } from '../room/RoomTasks.tsx'
import { jobExchangesQuery, roomJobsQuery } from '../room/room-queries.ts'
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

/**
 * Info › This job (3.22.0, "This topic" until 3.28.0): what the deleted thread panel showed for the job the composer
 * posts to, the live status with its round and turns, the run or recipe, report-back, Hermes tasks and Stop job.
 * Step-in answers stay on the pause card in the conversation (ExchangeRequestCard); the context meter and /compress live in the context bar.
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
  const [confirmingStop, setConfirmingStop] = useState(false)
  const stop = useStopJob(job, {
    onConfirming: setConfirmingStop,
    onStopped: () => void refetch(),
  })
  const turns = threadTurns(current, job)
  const state = current ? exchangeStatus(current) : jobStateLabel(job)
  const jobsLive = useStreamQuery(roomJobsQuery(job.roomId)).data?.find(
    (item) => item.id === job.id,
  )
  const reportState = (jobsLive?.reportBack ?? job.reportBack)?.state
  const reportWaits = reportState === 'needs_ok' || reportState === 'not_confirmed'
  const orchestrations = useStreamQuery(orchestrationsQuery).data ?? []
  const workflows = useStreamQuery(workflowRunsQuery).data ?? []
  const recipeMatch = job.recipe ? recipeRun(job.recipe, orchestrations, workflows) : undefined
  const recipeWaits = (recipeMatch?.summary.needsYou.length ?? 0) > 0
  return (
    <InfoSection
      kind="topic"
      className="bold-topic-info"
      headingId="chat-info-topic"
      title="This job"
      summary={job.title}
      needsYou={waiting || reportWaits || recipeWaits || confirmingStop}
    >
      <div className="bold-topic-head">
        <b className="bold-topic-title" title={job.title}>
          {job.title}
        </b>
        {stop.button}
        {stop.confirm}
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
    </InfoSection>
  )
}
