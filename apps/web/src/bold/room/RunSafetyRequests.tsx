import type { AgentSummary, Job } from '@score/contract'
import { OrchestrationRunRequests } from './OrchestrationRunRequests.tsx'
import { WorkflowRunRequests } from './WorkflowRunRequests.tsx'

export { orchestrationNeedEntries, workflowNeedEntries } from './run-safety-entries.ts'

/** The recipes among the room's jobs, each routed to the run that owns it. */
export function RunSafetyRequests({ jobs, agents }: { jobs: Job[]; agents: AgentSummary[] }) {
  return (
    <>
      {jobs.map((job) =>
        job.recipe?.kind === 'orchestration' ? (
          <OrchestrationRunRequests key={job.id} job={job} agents={agents} />
        ) : job.recipe?.kind === 'workflow' ? (
          <WorkflowRunRequests key={job.id} job={job} agents={agents} />
        ) : null,
      )}
    </>
  )
}
