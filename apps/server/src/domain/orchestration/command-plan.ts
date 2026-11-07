import { redact } from '../../redact.ts'
import { consult, consultsOf } from './advisor.ts'
import { ok, quotaRefusal, type Handler } from './command-support.ts'
import { addStored, utf8Bytes } from './ops.ts'

export const planCommand: Handler = (ctx, o, attempt, args) => {
  const entries = (args.entries as string[]).map((entry) => redact(entry))
  const bytes = utf8Bytes(JSON.stringify(entries))
  const quota = quotaRefusal(o, bytes)
  if (quota) return quota
  ctx.sqlite
    .prepare('UPDATE orchestrations SET plan = ? WHERE id = ?')
    .run(JSON.stringify(entries), o.id)
  addStored(ctx.sqlite, o.id, bytes)
  // 3.14: the first plan goes to the advisor before any work starts (orch.assign waits for its advice).
  const advising =
    o.advisor_agent_id &&
    !consultsOf(ctx.sqlite, o.id).some((step) => step.checkpoint === 'before_plan') &&
    consult(ctx, { ...o, plan: entries }, 'before_plan', '', attempt.id) !== null
  return ok({
    entries: entries.length,
    ...(advising
      ? { advisor: 'The advisor is looking at this plan; its advice starts your next turn.' }
      : {}),
  })
}
