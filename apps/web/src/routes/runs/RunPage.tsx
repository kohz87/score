import { Link, useParams } from 'react-router'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { OrchestrationLive } from '../orchestrations/OrchestrationLive.tsx'
import { statusLabel } from '../orchestrations/orch-model.ts'
import { orchestrationsQuery } from '../orchestrations/orchestration-queries.ts'
import { WorkflowRunLive } from '../workflows/WorkflowRunLive.tsx'
import { workflowRunsQuery } from '../workflows/workflow-queries.ts'

/** A run from its brief id, which is what room panels, history and notifications link to. */
export function RunPage() {
  const { briefId = '' } = useParams()
  const orchestrations = useStreamQuery(orchestrationsQuery)
  const workflows = useStreamQuery(workflowRunsQuery)
  const refetchOrchestrations = useStreamQueryRefetch(orchestrationsQuery)
  const refetchWorkflows = useStreamQueryRefetch(workflowRunsQuery)
  const orchestration = orchestrations.data?.find((run) => run.briefId === briefId)
  const workflow = workflows.data?.find((run) => run.briefId === briefId)
  const loading =
    orchestration === undefined &&
    workflow === undefined &&
    (orchestrations.status === 'pending' || workflows.status === 'pending')
  const failed =
    orchestration === undefined &&
    workflow === undefined &&
    orchestrations.status === 'error' &&
    workflows.status === 'error'

  if (failed)
    return (
      <div className="orch-page">
        <p role="alert">
          Couldn’t load this run.{' '}
          <button
            type="button"
            onClick={() => {
              void refetchOrchestrations()
              void refetchWorkflows()
            }}
          >
            Try again
          </button>
        </p>
      </div>
    )
  if (loading)
    return (
      <div className="orch-page">
        <p role="status">Loading the run…</p>
      </div>
    )
  if (!orchestration && !workflow)
    return (
      <div className="orch-page">
        <p role="alert">That run isn’t available.</p>
        <p>
          <Link to="/b">Back to Score</Link>
        </p>
      </div>
    )
  if (workflow)
    return (
      <div className="orch-page">
        <WorkflowRunLive key={workflow.id} runId={workflow.id} onStarted={() => {}} />
      </div>
    )
  return (
    <div className="orch-page">
      <p className="orch-muted">Run {statusLabel[orchestration!.status]}</p>
      <OrchestrationLive key={orchestration!.id} orchestrationId={orchestration!.id} />
    </div>
  )
}
