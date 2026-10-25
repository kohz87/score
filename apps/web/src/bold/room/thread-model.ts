import type {
  Exchange,
  Job,
  Message,
  OrchestrationSummary,
  WorkflowRunSummary,
} from '@score/contract'
import { needsYou } from './room-model.ts'

export type JobRecipe = NonNullable<Job['recipe']>

export type ThreadRound = {
  key: string
  label: string
  number: number | null
  messages: Message[]
}

export type RecipeRunMatch =
  | { kind: 'orchestration'; summary: OrchestrationSummary }
  | { kind: 'workflow'; summary: WorkflowRunSummary }

/** The server's name for one agent's session in a job (PLAN 11.1a). */
export function jobSessionId(
  roomId: string,
  job: { id: string; isDefault: boolean },
  agentId: string,
): string {
  // The default job is the room's own conversation: it uses the room session, not a job session.
  return job.isDefault ? `score-${roomId}-${agentId}` : `score-${roomId}-${job.id}-${agentId}`
}

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

function reviewState(message: Message): 'approved' | 'changes_requested' | null {
  for (const part of message.parts) if (part.kind === 'review') return part.verdict
  return null
}

/**
 * The contract carries the exchange's current round, not which message belongs to which round. Messages do carry
 * review verdicts, and each "changes requested" starts the next review round (contract §5), so those verdicts are the
 * only boundaries available, and only when the job has a single review exchange (with several, a verdict can't be
 * attributed, so the page stays "Messages"). While older messages are not loaded, the first chunk is "Earlier
 * messages" and only chunks after a loaded verdict are numbered.
 */
export function threadRounds(
  messages: Message[],
  options: { hasEarlier?: boolean; reviewExchanges?: number } = {},
): ThreadRound[] {
  const sorted = [...messages].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
  if (sorted.length === 0) return []
  const hasEarlier = options.hasEarlier ?? false
  const attributable = (options.reviewExchanges ?? 1) <= 1
  if (!attributable || !sorted.some((message) => reviewState(message) !== null))
    return [{ key: sorted[0]!.id, label: 'Messages', number: null, messages: sorted }]
  const chunks: Message[][] = [[]]
  sorted.forEach((message, index) => {
    chunks.at(-1)!.push(message)
    if (reviewState(message) === 'changes_requested' && index < sorted.length - 1) chunks.push([])
  })
  return chunks.map((chunk, index) => {
    const earlier = hasEarlier && index === 0
    // Without older pages the first chunk is round 1; with them, numbers would be guesses, so count from the
    // chunks that start after a loaded send-back as "Review round" only when nothing earlier is unseen.
    const number = hasEarlier ? null : index + 1
    return {
      key: chunk[0]!.id,
      label: earlier ? 'Earlier messages' : number ? `Round ${number}` : 'Later in the review',
      number,
      messages: chunk,
    }
  })
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
