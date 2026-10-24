import type {
  Exchange,
  Job,
  Message,
  OrchestrationSummary,
  WorkflowRunSummary,
} from '@score/contract'

export type JobRecipe = NonNullable<Job['recipe']>

export type ThreadRound = {
  label: string
  number: number | null
  messages: Message[]
}

export type RecipeRunMatch =
  | { kind: 'orchestration'; summary: OrchestrationSummary }
  | { kind: 'workflow'; summary: WorkflowRunSummary }

/** The server's name for one agent's session in a job (PLAN 11.1a). */
export function jobSessionId(roomId: string, jobId: string, agentId: string): string {
  return `score-${roomId}-${jobId}-${agentId}`
}

export function threadTurns(exchange: Exchange | undefined): string | null {
  return exchange ? `${exchange.turnsUsed} of ${exchange.budget} turns used` : null
}

/** The exchange whose turns and pause the thread header describes. */
export function currentExchange(exchanges: Exchange[]): Exchange | undefined {
  return (
    [...exchanges].reverse().find((item) => item.state !== 'done' && item.state !== 'stopped') ??
    exchanges.at(-1)
  )
}

function reviewState(message: Message): 'approved' | 'changes_requested' | null {
  for (const part of message.parts) if (part.kind === 'review') return part.verdict
  return null
}

/**
 * The contract carries the exchange's current round, not which message belongs to which round. Messages do carry
 * review verdicts, and each "changes requested" starts the next review round (contract §5), so those verdicts are the
 * only honest boundaries available. Without one, the whole page is labelled as messages rather than inventing rounds.
 */
export function threadRounds(messages: Message[]): ThreadRound[] {
  const sorted = [...messages].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
  if (sorted.length === 0) return []
  const chunks: Message[][] = [[]]
  sorted.forEach((message, index) => {
    chunks.at(-1)!.push(message)
    if (
      reviewState(message) === 'changes_requested' &&
      index < sorted.length - 1 &&
      chunks.at(-1)!.length > 0
    )
      chunks.push([])
  })
  const reviewed = sorted.some((message) => reviewState(message) !== null)
  return chunks
    .filter((chunk) => chunk.length > 0)
    .map((chunk, index) => ({
      label: reviewed ? `Round ${index + 1}` : 'Messages',
      number: reviewed ? index + 1 : null,
      messages: chunk,
    }))
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

export function needsRecipeRun(match: RecipeRunMatch): boolean {
  return match.summary.needsYou.length > 0
}
