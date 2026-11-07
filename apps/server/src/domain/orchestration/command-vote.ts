import { redact } from '../../redact.ts'
import { agentAdmits } from '../agent-lifecycle.ts'
import { awaitCheckpoint } from './advisor.ts'
import { budgetView, canReserve, unknownCostBlocks } from './budget.ts'
import { containsCapability } from './capability.ts'
import { ok, quotaRefusal, refuse, type Handler } from './command-support.ts'
import { helperStepsLeft, helpersOf, startVote, votersOf } from './helpers.ts'
import { utf8Bytes } from './ops.ts'

export const voteCommand: Handler = (ctx, o, attempt, args) => {
  const { sqlite, now } = ctx
  const helpers = helpersOf(o)
  if (!helpers) return refuse('no_helpers', 'This job has no helpers to vote')
  // Votes start without approval; a job where the person approves every step gets none.
  if (o.gate_policy === 'every-step')
    return refuse(
      'gated',
      'The person approves every step in this job, so votes are off; decide yourself or orch.ask',
    )
  if (o.deadline_at !== null && now >= o.deadline_at)
    return refuse('deadline_passed', 'The run deadline has passed')
  // Like any work, a vote waits for the advisor's look at the plan, and for unknown spend to be accepted.
  const waiting = awaitCheckpoint(ctx, o, 'before_plan', attempt.id)
  if (waiting) return refuse(waiting.code, waiting.message)
  if (unknownCostBlocks(sqlite, o, budgetView(sqlite, o)))
    return refuse(
      'unknown_spend',
      'Spend of an earlier attempt is unknown; the person has to accept that first',
    )
  const k = args.k as number
  if (helperStepsLeft(sqlite, o.id, helpers) < k)
    return refuse(
      'helper_limit',
      `A vote of ${k} needs ${k} helper steps; ${helperStepsLeft(sqlite, o.id, helpers)} are left`,
    )
  if (!votersOf(helpers).some((agent) => agentAdmits(sqlite, agent)))
    return refuse('agent_unavailable', 'No voter is ready for new work')
  const view = budgetView(sqlite, o)
  if (!canReserve(view, o.step_estimate_usd * k))
    return refuse(
      'budget_exceeded',
      `A vote of ${k} is estimated at $${(o.step_estimate_usd * k).toFixed(2)}; the budget can't cover it`,
    )
  const question = redact(args.question as string)
  const options = (args.options as string[]).map((option) => redact(option))
  if (containsCapability(question) || options.some(containsCapability))
    return refuse(
      'capability_in_text',
      'The vote contains something shaped like a capability; remove it',
    )
  const quota = quotaRefusal(o, (utf8Bytes(question) + 512) * (k + 1))
  if (quota) return quota
  const voteId = startVote(ctx, o, helpers, { question, options, k, createdIn: attempt.id })
  return ok({
    voteId,
    note: 'The helpers are voting; the tally starts a new turn for you. End this turn.',
  })
}
