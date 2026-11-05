import { RoomQueueResponseSchema, type AgentSummary, type Job } from '@score/contract'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useStream, useStreamQuery } from '../../data/query-client.ts'
import { useRun, orchestrationsQuery } from '../../routes/orchestrations/orchestration-queries.ts'
import { workflowRunsQuery } from '../../routes/workflows/workflow-queries.ts'
import { agentDisplayName } from '../bold-agents.ts'
import { isRunOver } from '../../routes/orchestrations/orch-model.ts'
import { stepOf } from './RunCard.tsx'
import { jobStateLabel } from './room-model.ts'
import { useStopJob } from './StopJob.tsx'
import { recipeRun } from './thread-model.ts'
import { jobDot } from './job-dot.ts'
import { goToNearestCard } from './needs-jump-dom.ts'

const money = (usd: number) => `$${usd.toFixed(2)}`

function names(ids: string[], agents: AgentSummary[]): string {
  const list = ids.map((id) => {
    const agent = agents.find((item) => item.id === id)
    return agent ? agentDisplayName(agent) : id
  })
  if (list.length <= 1) return list[0] ?? ''
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
}

/** "lead is working · step 3 of 6 · $0.42 of $5.00": who, how far and how much, each only when known. */
export function jobBarLine(
  job: Job,
  agents: AgentSummary[],
  step: string | null,
  spentUsd: number | null,
): string {
  const parts: string[] = []
  const who =
    job.activeAgents.length > 0 ? job.activeAgents : job.holderAgentId ? [job.holderAgentId] : []
  if (job.state === 'waiting_on_you')
    parts.push(who.length > 0 ? `${names(who.slice(0, 1), agents)} needs you` : 'Needs you')
  else if (who.length > 0)
    parts.push(
      `${names(who, agents)} ${job.state === 'open' ? 'is up next' : who.length > 1 ? 'are working' : 'is working'}`,
    )
  else parts.push(jobStateLabel(job))
  if (step) parts.push(step)
  if (job.spendCapUsd !== null && spentUsd !== null)
    parts.push(`${money(spentUsd)} of ${money(job.spendCapUsd)}`)
  else if (job.spendCapUsd !== null) parts.push(`cap ${money(job.spendCapUsd)}`)
  return parts.join(' · ')
}

/**
 * The job bar (3.28.0, mock-up 22): under the chat header while the chat has an active job. A state dot, the JOB
 * eyebrow, the title on one line (its tooltip has all of it), who is working with the step and the spend when the run
 * says so, Graph when the job has a run, and Stop job (asks first, then ends the run and the work). It asks the person
 * to decide, so it carries data-protected.
 */
export function JobBar({
  job,
  agents,
  onShowGraph,
  menu,
  moreOpen = 0,
  onShowMore,
  onStopped,
}: {
  job: Job
  agents: AgentSummary[]
  onShowGraph?: (jobId: string) => void
  /** The job's ⋯ menu (rename, close, share, export, delete): the dividers that carried it are gone with one job. */
  menu?: ReactNode
  /** An older chat that still holds several open jobs: the bar is the newest one's, and "+N more open" opens Info. */
  moreOpen?: number
  onShowMore?: () => void
  /** Stop job finished: the bar is about to go, so the chat shows the result where it was. */
  onStopped?: (job: Job) => void
}) {
  const orchestrations = useStreamQuery(orchestrationsQuery).data ?? []
  const workflows = useStreamQuery(workflowRunsQuery).data ?? []
  const match = recipeRun(job.recipe, orchestrations, workflows)
  // The spend comes from the run's detail, read only while the run goes on (a finished run never fetches one).
  const going = match !== null && !isRunOver(match.summary.status)
  const detail = useRun(going && job.recipe?.kind === 'orchestration' ? job.recipe.ref : undefined)
  const budget = detail.data?.snapshot.orchestration.budget
  const spent = budget ? budget.settledUsd + budget.provisionalUsd : null
  const step = match
    ? match.kind === 'orchestration'
      ? stepOf(
          match.summary.status,
          match.summary.steps.succeeded,
          match.summary.steps.total,
          match.summary.untilStopped,
        )
      : stepOf(match.summary.status, match.summary.nodes.succeeded, match.summary.nodes.total)
    : null
  return (
    <section
      className="bold-job-bar"
      aria-label="Current job"
      data-protected="block"
      data-job-id={job.id}
    >
      <JobBarBody
        job={job}
        line={jobBarLine(job, agents, step, spent)}
        onShowGraph={job.recipe ? onShowGraph : undefined}
        menu={menu}
        moreOpen={moreOpen}
        onShowMore={onShowMore}
        onStopped={onStopped}
      />
    </section>
  )
}

/**
 * A finished job the person opened from Past jobs (`?job=`): the same bar shape without Stop job, with its ⋯ menu
 * (Reopen, Rename, Share, Export, Delete), since the divider that used to carry that menu is gone.
 */
export function PastJobBar({
  job,
  onShowGraph,
  menu,
}: {
  job: Job
  onShowGraph?: (jobId: string) => void
  menu?: ReactNode
}) {
  return (
    <section
      className="bold-job-bar is-past"
      aria-label="Past job"
      data-protected="block"
      data-job-id={job.id}
    >
      <div className="bold-job-bar-row">
        <span
          className="bold-job-bar-dot"
          aria-hidden="true"
          style={{ background: jobDot(job.state) }}
        />
        <div className="bold-job-bar-text">
          <span className="bold-job-bar-eyebrow">PAST JOB</span>
          <b className="bold-job-bar-title" title={job.title}>
            {job.title}
          </b>
          <span className="bold-job-bar-line">{jobStateLabel(job)} · opened read-only</span>
        </div>
        {job.recipe && onShowGraph && (
          <button
            type="button"
            className="btn sm bold-job-bar-graph"
            onClick={() => onShowGraph(job.id)}
          >
            Graph
          </button>
        )}
        {menu}
      </div>
    </section>
  )
}

function JobBarBody({
  job,
  line,
  onShowGraph,
  menu,
  moreOpen,
  onShowMore,
  onStopped,
}: {
  job: Job
  line: string
  onShowGraph: ((jobId: string) => void) | undefined
  menu: ReactNode
  moreOpen: number
  onShowMore: (() => void) | undefined
  onStopped: ((job: Job) => void) | undefined
}) {
  const stop = useStopJob(job, { onStopped: () => onStopped?.(job) })
  return (
    <>
      <div className="bold-job-bar-row">
        <span
          className="bold-job-bar-dot"
          aria-hidden="true"
          style={{ background: jobDot(job.state) }}
        />
        <div className="bold-job-bar-text">
          <span className="bold-job-bar-eyebrow">JOB</span>
          <b className="bold-job-bar-title" title={job.title}>
            {job.title}
          </b>
          <span className="bold-job-bar-line">{line}</span>
          {moreOpen > 0 && onShowMore && (
            <button type="button" className="bold-job-bar-more" onClick={onShowMore}>
              +{moreOpen} more open
            </button>
          )}
        </div>
        {job.state === 'waiting_on_you' && (
          <button
            type="button"
            className="bold-job-bar-needs"
            data-protected="inline-flex"
            aria-label="This job needs you. Go to the card."
            onClick={() => goToNearestCard()}
          >
            Needs you
          </button>
        )}
        {onShowGraph && (
          <button
            type="button"
            className="btn sm bold-job-bar-graph"
            onClick={() => onShowGraph(job.id)}
          >
            Graph
          </button>
        )}
        {stop.button}
        {menu}
      </div>
      {stop.confirm}
    </>
  )
}

/** Next up (3.28.0): a trigger call waiting for this chat's job to end, one line each, with Skip. */
export function NextUp({ roomId }: { roomId: string }) {
  const queryClient = useQueryClient()
  const stream = useStream()
  const key = ['bold', 'room-queue', roomId]
  const queue = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      RoomQueueResponseSchema.parse(
        await apiFetch(`rooms/${encodeURIComponent(roomId)}/queue`, { signal }),
      ).items,
  })
  // Queue changes are announced as the room's `room.upserted`; the list is read again then.
  useEffect(
    () =>
      stream.subscribe((event) => {
        if (event.type === 'room.upserted' && event.data.id === roomId)
          void queryClient.invalidateQueries({ queryKey: ['bold', 'room-queue', roomId] })
      }),
    [queryClient, roomId, stream],
  )
  const [skipping, setSkipping] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function skip(itemId: string) {
    setSkipping(itemId)
    setError(null)
    try {
      await apiFetch(`rooms/${encodeURIComponent(roomId)}/queue/${encodeURIComponent(itemId)}`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': newId() },
      })
    } catch {
      setError('Couldn’t skip that. Try again.')
    } finally {
      setSkipping(null)
      await queryClient.invalidateQueries({ queryKey: ['bold', 'room-queue', roomId] })
    }
  }
  const items = queue.data ?? []
  if (items.length === 0 && !error) return null
  return (
    <>
      {items.map((item) => (
        <section key={item.id} className="bold-next-up" aria-label="Next up" data-protected="block">
          <span className="bold-next-up-dot" aria-hidden="true" />
          <span className="bold-next-up-text">
            <b>Next up:</b> “{item.title}” from {item.source.app} waits until this job ends.
          </span>
          <button
            type="button"
            className="btn sm"
            disabled={skipping === item.id}
            aria-label={`Skip “${item.title}”`}
            onClick={() => void skip(item.id)}
          >
            Skip
          </button>
        </section>
      ))}
      {error && (
        <p className="bold-thread-error bold-next-up-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
