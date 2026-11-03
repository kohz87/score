import type { AgentSummary, Job } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useStreamQuery } from '../../data/query-client.ts'
import { orchestrationsQuery, useRun } from '../../routes/orchestrations/orchestration-queries.ts'
import { statusLabel } from '../../routes/orchestrations/orch-model.ts'
import { briefHasRun } from '../../routes/runs/brief-run.ts'
import { useWorkflowRun, workflowRunsQuery } from '../../routes/workflows/workflow-queries.ts'
import { boldRunLink } from '../bold-links.ts'
import { orchestrationThread, workflowThread, type ThreadStep } from '../bold-runs-model.ts'
import { agentDisplayName } from '../bold-agents.ts'
import { recipeRun, recipeSummaryLine, type JobRecipe } from './thread-model.ts'

/** The steps with an agent working right now, from the run's own detail (the lead's planning turn counts). */
function working(steps: ThreadStep[]): ThreadStep[] {
  return steps.filter((step) => step.visual === 'running' && step.agentId)
}

/** How far along, 0 to 100, from the summary's own counts. */
function percent(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
}

/**
 * The run card in the chat's stream (3.23.0, mock-up 18): right after its topic's divider, the title, the status, the
 * steps done of the total, who is on what, a needs-you line when the run waits on the person, and Show graph, which
 * opens the side panel's Graph tab for this topic. It reads what the Runs page reads; nothing new is fetched.
 */
export function RunCard({
  job,
  recipe,
  agents,
  onShowGraph,
}: {
  job: Pick<Job, 'id' | 'title'>
  recipe: JobRecipe
  agents: AgentSummary[]
  onShowGraph: (jobId: string) => void
}) {
  const orchestrations = useStreamQuery(orchestrationsQuery).data ?? []
  const workflows = useStreamQuery(workflowRunsQuery).data ?? []
  const match = recipeRun(recipe, orchestrations, workflows)
  const orchestration = useRun(recipe.kind === 'orchestration' ? recipe.ref : undefined)
  const workflow = useWorkflowRun(recipe.kind === 'workflow' ? recipe.ref : undefined)
  const detailSteps: ThreadStep[] =
    recipe.kind === 'orchestration' && orchestration.data
      ? orchestrationThread(orchestration.data.snapshot.orchestration)
      : recipe.kind === 'workflow' && workflow.data
        ? workflowThread(workflow.data.snapshot.run)
        : []
  const busy = working(detailSteps)
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
            {total > 0 ? recipeSummaryLine(match) : status}
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
            {status && <span>{status}</span>}
            {busy.map((step) => {
              const agent = agents.find((item) => item.id === step.agentId)
              return (
                <span key={step.id} className="bold-run-card-agent">
                  {agent && <AgentGlyph agent={agent} size="sm" bare decorative />}
                  <b>{agent ? agentDisplayName(agent) : step.agentId}</b>: {step.title}
                </span>
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
