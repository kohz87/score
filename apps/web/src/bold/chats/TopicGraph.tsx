import type { Job } from '@score/contract'
import { Link } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { orchestrationsQuery } from '../../routes/orchestrations/orchestration-queries.ts'
import { statusLabel } from '../../routes/orchestrations/orch-model.ts'
import { briefHasRun } from '../../routes/runs/brief-run.ts'
import { workflowRunsQuery } from '../../routes/workflows/workflow-queries.ts'
import { WorkflowRunLive } from '../../routes/workflows/WorkflowRunLive.tsx'
import { ClassicPaper } from '../BoldRuns.tsx'
import { boldRunLink } from '../bold-links.ts'
import { JobMap } from '../jobmap/JobMap.tsx'
import { recipeRun } from '../room/thread-model.ts'

/**
 * The side panel's Graph tab (3.23.0, mock-up 18): "Run · title" and its state, then the run's graph with its moving dots
 * and phases (the job map for a lead-decides run, the recipe's live graph for a recipe run), then the Session log. The
 * parts are the Runs page's own, so the graph and the log update live here as they do there.
 */
export function TopicGraph({ job }: { job: Job }) {
  const orchestrations = useStreamQuery(orchestrationsQuery).data ?? []
  const workflows = useStreamQuery(workflowRunsQuery).data ?? []
  const recipe = job.recipe
  const match = recipeRun(recipe, orchestrations, workflows)
  if (!recipe) return null
  const runHref =
    match && briefHasRun(match.summary.briefId, orchestrations, workflows)
      ? boldRunLink(match.summary.briefId)
      : null
  return (
    <div className="sidebody bold-topic-graph" aria-label={`Graph of ${job.title}`}>
      <p className="bold-topic-graph-head">
        <span>Run · {match?.summary.title ?? job.title}</span>
        {match && (
          <span className="bold-topic-graph-state">{statusLabel[match.summary.status]}</span>
        )}
      </p>
      {recipe.kind === 'orchestration' ? (
        // The job map carries its own Session log under the graph.
        <JobMap orchestrationId={recipe.ref} />
      ) : (
        <>
          <ClassicPaper>
            <WorkflowRunLive runId={recipe.ref} onStarted={() => {}} pane="graph" />
          </ClassicPaper>
          <section className="bold-topic-graph-log" aria-label="Session log">
            <h3>Session log</h3>
            <ClassicPaper>
              <WorkflowRunLive runId={recipe.ref} onStarted={() => {}} pane="log" />
            </ClassicPaper>
          </section>
        </>
      )}
      {runHref && (
        <Link className="bold-chat-knowledge" to={runHref}>
          Open the run
        </Link>
      )}
    </div>
  )
}
