import type { Job } from '@score/contract'
import { useMemo } from 'react'
import { useStreamQuery } from '../../data/query-client.ts'
import { isRunOver } from '../../routes/orchestrations/orch-model.ts'
import { orchestrationsQuery } from '../../routes/orchestrations/orchestration-queries.ts'
import { workflowRunsQuery } from '../../routes/workflows/workflow-queries.ts'
import { recipeRun } from './thread-model.ts'

export function useRoomLiveCards(jobs: Job[]) {
  // Only the 3 newest cards of runs still going read their live detail; the rest (and every finished run) use summaries.
  const orchestrations = useStreamQuery(orchestrationsQuery).data
  const workflowRuns = useStreamQuery(workflowRunsQuery).data
  return useMemo(() => {
    const going = jobs.filter((job) => {
      const match = recipeRun(job.recipe ?? null, orchestrations ?? [], workflowRuns ?? [])
      return match !== null && !isRunOver(match.summary.status)
    })
    going.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return new Set(going.slice(0, 3).map((job) => job.id))
  }, [jobs, orchestrations, workflowRuns])
}
