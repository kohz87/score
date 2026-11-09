import { SUBAGENT_LIMITS, type AgentSubagents, type JobSubagentsRequest } from '@score/contract'

// SA.3 part 9 (docs/design/bold/mockups/24-subagents-start-job.dc.html): what Start a job sends for a job's subagents.
// Pure: the form's choices and the lead's settings in, the request out.

/** The "At once" choices the mock-up offers (the lead's limit caps them). */
export const SUBAGENT_AT_ONCE_CHOICES = [1, 2, 3, 4] as const

/** The lead's own limit, capped at the choices: the default the form starts from. */
export function subagentDefaultAt(
  ceiling: Pick<AgentSubagents, 'maxConcurrent'> | undefined,
): number {
  return Math.min(
    SUBAGENT_LIMITS.defaultConcurrent,
    ceiling?.maxConcurrent ?? SUBAGENT_LIMITS.defaultConcurrent,
  )
}

/**
 * The `subagents` the start request carries. Off always says so. On needs the lead's settings (what Score can enforce
 * depends on its program): none when they are not read yet, so the server's own default applies. A program Score can't
 * govern (`none`) is sent as off, never as on.
 */
export function subagentsRequestFor({
  on,
  at,
  total,
  ceiling,
}: {
  on: boolean
  at: number
  total: number
  ceiling: Pick<AgentSubagents, 'control' | 'maxConcurrent'> | undefined
}): JobSubagentsRequest | undefined {
  if (!on) return { enabled: false }
  if (!ceiling) return undefined
  if (ceiling.control === 'none') return { enabled: false }
  // Claude Code decides how many run at once, so the job's own count is the only figure it has.
  if (ceiling.control === 'on_off') return { enabled: true, maxConcurrent: null, maxTotal: total }
  return {
    enabled: true,
    maxConcurrent: Math.min(at, ceiling.maxConcurrent),
    maxTotal: total,
  }
}

/**
 * The form's subagent facts from the lead's settings and the choices: what the lead allows, whether it is still being
 * read, the count to show, the total's check and the request. A routine or trigger starts its work later, so it sends
 * nothing now.
 */
export function deriveSubagentChoice({
  startsNow,
  hasLead,
  query,
  on,
  at,
  total,
}: {
  startsNow: boolean
  hasLead: boolean
  query: { data: AgentSubagents | undefined; isPending: boolean; isError: boolean }
  on: boolean
  at: number | null
  total: string
}) {
  const ceiling = query.data
  const loading = startsNow && hasLead && query.isPending
  const atNow = Math.min(
    at ?? subagentDefaultAt(ceiling),
    ceiling?.maxConcurrent ?? SUBAGENT_LIMITS.maxConcurrent,
  )
  const totalNumber = Number(total)
  const totalValid =
    Number.isInteger(totalNumber) && totalNumber >= 1 && totalNumber <= SUBAGENT_LIMITS.maxTotal
  const counted = startsNow && on && ceiling?.control !== 'none'
  const problem = loading
    ? 'Still reading the lead’s subagent settings.'
    : counted && !totalValid
      ? `The total must be a whole number from 1 to ${SUBAGENT_LIMITS.maxTotal}`
      : null
  const request = startsNow
    ? subagentsRequestFor({ on, at: atNow, total: totalNumber, ceiling })
    : undefined
  return {
    subagentsCeiling: ceiling,
    subagentsLoading: loading,
    subagentsError: startsNow && hasLead && query.isError,
    subagentsAtNow: atNow,
    subagentsTotalValid: totalValid,
    subagentsProblem: problem,
    subagentsRequest: request,
  }
}
