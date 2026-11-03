import type { Exchange, Job, OrchestrationSummary, WorkflowRunSummary } from '@score/contract'
import { needsYou } from './room-model.ts'

/**
 * The exchange the header, the decision card, step-in and the capsule all talk about: the one that needs the person
 * first, else the latest one still running, else the last one.
 */
export function currentExchange(exchanges: Exchange[]): Exchange | undefined {
  return (
    exchanges.find(needsYou) ??
    [...exchanges].reverse().find((item) => item.state !== 'done' && item.state !== 'stopped') ??
    exchanges.at(-1)
  )
}

export type JobRecipe = NonNullable<Job['recipe']>

export type RecipeRunMatch =
  | { kind: 'orchestration'; summary: OrchestrationSummary }
  | { kind: 'workflow'; summary: WorkflowRunSummary }

export function threadTurns(
  exchange: Exchange | undefined,
  job?: Pick<Job, 'jobTurnLimit'>,
): string | null {
  if (!exchange) return null
  // On a job-limit pause the exchange's own budget is not what stopped it.
  if (exchange.pause?.reason === 'job_limit' && job)
    return `Job turn limit reached (${job.jobTurnLimit})`
  return `${exchange.turnsUsed} of ${exchange.budget} turns used`
}

export function recipeRun(
  recipe: JobRecipe | null,
  orchestrations: OrchestrationSummary[],
  workflows: WorkflowRunSummary[],
): RecipeRunMatch | null {
  if (!recipe) return null
  if (recipe.kind === 'orchestration') {
    const summary = orchestrations.find((item) => item.id === recipe.ref)
    return summary ? { kind: 'orchestration', summary } : null
  }
  const summary = workflows.find((item) => item.id === recipe.ref)
  return summary ? { kind: 'workflow', summary } : null
}

export function recipeSummaryLine(match: RecipeRunMatch): string {
  if (match.kind === 'orchestration') {
    const steps = match.summary.steps
    return `${steps.succeeded} of ${steps.total} steps done`
  }
  const nodes = match.summary.nodes
  return `${nodes.succeeded} of ${nodes.total} steps done`
}
