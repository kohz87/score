import type { OrchestrationSummary, WorkflowRunSummary } from '@score/contract'

/** `/runs/:briefId` can open a brief only when an orchestration or workflow run still points at it. */
export function briefHasRun(
  briefId: string | null | undefined,
  orchestrations: readonly OrchestrationSummary[],
  workflows: readonly WorkflowRunSummary[],
): boolean {
  if (!briefId) return false
  return (
    orchestrations.some((run) => run.briefId === briefId) ||
    workflows.some((run) => run.briefId === briefId)
  )
}
