import type { AgentSummary, Job } from '@score/contract'
import { Fragment } from 'react'
import { Link } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { orchestrationsQuery, useRun } from '../../routes/orchestrations/orchestration-queries.ts'
import { isRunOver, statusLabel } from '../../routes/orchestrations/orch-model.ts'
import { briefHasRun } from '../../routes/runs/brief-run.ts'
import { useWorkflowRun, workflowRunsQuery } from '../../routes/workflows/workflow-queries.ts'
import { boldRunLink } from '../bold-links.ts'
import { orchestrationThread, workflowThread, type ThreadStep } from '../bold-runs-model.ts'
import { agentDisplayName } from '../bold-agents.ts'
import { recipeRun, recipeSummaryLine, type JobRecipe } from './thread-model.ts'

/** Who did or does what, in order: the agents' steps, plus the lead while it is planning. */
function crew(steps: ThreadStep[]): ThreadStep[] {
  return steps
    .filter(
      (step) =>
        step.agentId &&
        (step.kind === 'agent' || (step.kind === 'lead' && step.visual === 'running')),
    )
    .slice(0, 6)
}

const clipTitle = (text: string) => (text.length > 32 ? `${text.slice(0, 31)}…` : text)

/** "step N of M" while the run goes on; nothing once it is over (the status says it then). */
export function stepOf(
  status: Parameters<typeof isRunOver>[0],
  done: number,
  total: number,
  untilStopped = false,
): string | null {
  if (isRunOver(status)) return null
  // 3.27.0: a run with no step cap has no "of M" to count against.
  if (untilStopped) return 'until you stop it'
  if (total === 0) return null
  return `step ${Math.min(done + 1, total)} of ${total}`
}

/** How far along, 0 to 100, from the summary's own counts. */
function percent(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
}

/**
 * The run card in the chat's stream (3.23.0, mock-up 18): right after its topic's divider, the title, the status, the
 * steps done of the total, who is on what, a needs-you line when the run waits on the person, and Show graph, which
 * opens the side panel's Graph tab for this topic. It reads the run summaries the Runs page reads. Only a run that is
 * still going, and only for the few newest such cards (`live`), also reads its detail for the "who is on what" line;
 * a finished run never fetches one.
 */
export function RunCard({
  job,
  recipe,
  agents,
  live = false,
  onShowGraph,
}: {
  job: Pick<Job, 'id' | 'title'>
  recipe: JobRecipe
  agents: AgentSummary[]
  /** The card may read the run's live detail (it is not finished and is among the newest such cards). */
  live?: boolean
  onShowGraph: (jobId: string) => void
}) {
  const orchestrations = useStreamQuery(orchestrationsQuery).data ?? []
  const workflows = useStreamQuery(workflowRunsQuery).data ?? []
  const match = recipeRun(recipe, orchestrations, workflows)
  const readDetail = live && match !== null && !isRunOver(match.summary.status)
  const orchestration = useRun(
    readDetail && recipe.kind === 'orchestration' ? recipe.ref : undefined,
  )
  const workflow = useWorkflowRun(readDetail && recipe.kind === 'workflow' ? recipe.ref : undefined)
  const detailSteps: ThreadStep[] =
    readDetail && recipe.kind === 'orchestration' && orchestration.data
      ? orchestrationThread(orchestration.data.snapshot.orchestration)
      : readDetail && recipe.kind === 'workflow' && workflow.data
        ? workflowThread(workflow.data.snapshot.run)
        : []
  const crewSteps = crew(detailSteps)
  const runHref =
    match && briefHasRun(match.summary.briefId, orchestrations, workflows)
      ? boldRunLink(match.summary.briefId)
      : null
  const needs = match?.summary.needsYou.length ?? 0
  const done = match
    ? match.kind === 'orchestration'
      ? match.summary.steps.succeeded
      : match.summary.nodes.succeeded
    : 0
  const total = match
    ? match.kind === 'orchestration'
      ? match.summary.steps.total
      : match.summary.nodes.total
    : 0
  const status = match ? statusLabel[match.summary.status] : null
  return (
    <section className="bold-run-card" aria-label={`Run: ${match?.summary.title ?? job.title}`}>
      <div className="bold-run-card-head">
        <strong>Run · {match?.summary.title ?? job.title}</strong>
        {match && (
          <span className="bold-run-card-state">
            {stepOf(
              match.summary.status,
              done,
              total,
              match.kind === 'orchestration' && match.summary.untilStopped,
            ) ?? (total > 0 ? recipeSummaryLine(match) : status)}
          </span>
        )}
      </div>
      {match ? (
        <>
          <span
            className="bold-run-card-bar"
            role="progressbar"
            aria-label="Steps done"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
          >
            <span style={{ width: `${percent(done, total)}%` }} />
          </span>
          <span className="bold-run-card-who">
            {crewSteps.length === 0
              ? status && <span>{status}</span>
              : crewSteps.map((step, index) => {
                  const agent = agents.find((item) => item.id === step.agentId)
                  const name = agent ? agentDisplayName(agent) : step.agentId
                  const doing = step.visual === 'running'
                  return (
                    <Fragment key={step.id}>
                      {index > 0 && ' · '}
                      <span className={doing ? 'bold-run-card-agent on' : 'bold-run-card-agent'}>
                        {step.visual === 'succeeded' && '✓ '}
                        {name}: {clipTitle(step.title)}
                      </span>
                    </Fragment>
                  )
                })}
          </span>
          {needs > 0 && (
            <p className="bold-run-needs" data-protected="block">
              <b>
                {needs === 1
                  ? 'This run is waiting for you'
                  : `This run is waiting for you (${needs})`}
              </b>
              {runHref && <Link to={runHref}>Decide in the run</Link>}
            </p>
          )}
        </>
      ) : (
        <span className="small muted">
          This topic links to a run ({recipe.ref}) that isn’t in the run list.
        </span>
      )}
      <button type="button" className="bold-run-card-graph" onClick={() => onShowGraph(job.id)}>
        Show graph
      </button>
    </section>
  )
}
