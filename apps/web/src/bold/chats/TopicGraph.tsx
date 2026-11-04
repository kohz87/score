import type { Job } from '@score/contract'
import { useStreamQuery } from '../../data/query-client.ts'
import { orchestrationsQuery } from '../../routes/orchestrations/orchestration-queries.ts'
import { statusLabel } from '../../routes/orchestrations/orch-model.ts'
import { workflowRunsQuery } from '../../routes/workflows/workflow-queries.ts'
import { WorkflowRunLive } from '../../routes/workflows/WorkflowRunLive.tsx'
import { ClassicPaper } from '../ClassicPaper.tsx'
import { JobMap } from '../jobmap/JobMap.tsx'
import { recipeRun, type JobRecipe } from '../room/thread-model.ts'
import { RunControlsBar } from './RunControlsBar.tsx'
import { RunDetails } from './RunDetails.tsx'

/**
 * A run's graph (under its Pause / Resume / Stop and any changed-agent warning) with its moving dots and phases (the job map for a lead-decides run, the recipe's live graph for a recipe
 * run), the Session log under it, and the folded Run details (3.29.0). The chat's Graph tab and the read-only sheet for a
 * run that belongs to no chat both draw this.
 */
export function RunGraph({ recipe }: { recipe: JobRecipe }) {
  return (
    <>
      <RunControlsBar recipe={recipe} />
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
      <RunDetails recipe={recipe} />
    </>
  )
}

/**
 * The side panel's Graph tab (3.23.0, mock-up 18): "Run · title" and its state, then the run's graph and log. The run's
 * own page is gone (3.29.0): this tab is where a run is read.
 */
export function TopicGraph({ job }: { job: Job }) {
  const orchestrations = useStreamQuery(orchestrationsQuery).data ?? []
  const workflows = useStreamQuery(workflowRunsQuery).data ?? []
  const recipe = job.recipe
  const match = recipeRun(recipe, orchestrations, workflows)
  if (!recipe) return null
  return (
    <div className="sidebody bold-topic-graph" aria-label={`Graph of ${job.title}`}>
      <p className="bold-topic-graph-head">
        <span>Run · {match?.summary.title ?? job.title}</span>
        {match && (
          <span className="bold-topic-graph-state">{statusLabel[match.summary.status]}</span>
        )}
      </p>
      <RunGraph recipe={recipe} />
    </div>
  )
}
