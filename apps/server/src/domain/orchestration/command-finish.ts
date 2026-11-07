import { redact } from '../../redact.ts'
import { awaitCheckpoint } from './advisor.ts'
import { checkConfigOf, finishRefusal, queueCheck } from './checks.ts'
import { ok, refuse, type Handler } from './command-support.ts'
import { beginFinish } from './ops.ts'

export const checkCommand: Handler = (ctx, o) => {
  if (checkConfigOf(ctx.sqlite, o.id) === null)
    return refuse(
      'no_check',
      'This job has no check. Only the person can set one, when the job starts.',
    )
  const checkId = queueCheck(ctx, o.id, 'lead')
  if (checkId === null)
    return refuse(
      'check_limit',
      'The check has run as often as this job allows; finish partial or failed, or ask the person',
    )
  return ok({ checkId, note: 'Queued. Its result starts a new turn for you; end this turn.' })
}

export const finishCommand: Handler = (ctx, o, attempt, args) => {
  const outcome = args.outcome as 'success' | 'partial' | 'failed'
  // 3.14: the advisor looks once before a successful finish (first, so the check then runs after its turn too); the
  // lead may finish anyway after its advice.
  const waiting = outcome === 'success' ? awaitCheckpoint(ctx, o, 'before_done', attempt.id) : null
  if (waiting) return refuse(waiting.code, waiting.message)
  // 3.13: the oracle. A successful finish needs a current pass (or the person's waiver).
  const refusal = outcome === 'success' ? finishRefusal(ctx.sqlite, o) : null
  if (refusal) return refuse(refusal.code, refusal.message)
  const summary = redact(args.summary as string)
  const retired = beginFinish(ctx, o, attempt.id, outcome, summary)
  return ok({ finishing: true, retiredSteps: retired })
}

export const receiptCommand: Handler = () => refuse('internal', 'handled before dispatch')
