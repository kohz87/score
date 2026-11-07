import type { OrchReceipt } from '@score/contract'
import { createHash } from 'node:crypto'
import { redact } from '../../redact.ts'
import { agentAdmits, lifecycleOf } from '../agent-lifecycle.ts'
import { awaitCheckpoint, isAdvisorStep } from './advisor.ts'
import { budgetView, canReserve, unknownCostBlocks } from './budget.ts'
import { containsCapability } from './capability.ts'
import {
  ok,
  policyField,
  quotaRefusal,
  refuse,
  type Args,
  type Handler,
} from './command-support.ts'
import type { Ctx } from './ctx.ts'
import {
  autoVoteStep,
  helperStepsLeft,
  helpersOf,
  insertHelperStep,
  ROLE_PREAMBLE,
} from './helpers.ts'
import { addStored, utf8Bytes } from './ops.ts'
import { agentsWithRoom, holdStep, quotaCheck, windowPhrase } from './quota-guard.ts'
import { frozenIncarnation, gatesOf, stepsOf, type AttemptRow, type OrchRow } from './store.ts'

/**
 * 3.15: a step for a helper, with a role. Same rules as any assignment (the run's gate policy, budget, the agent the run
 * was started with, the advisor's look at the plan), but in the helpers' allowance and slots, without dependencies.
 */
function assignHelper(ctx: Ctx, o: OrchRow, attempt: AttemptRow, args: Args): OrchReceipt {
  const { sqlite, now } = ctx
  const helpers = helpersOf(o)
  const agent = args.agent as string
  const role = args.role as keyof typeof ROLE_PREAMBLE
  if (!helpers) return refuse('no_helpers', 'This job has no helpers; assign without a role')
  if (!helpers.agentIds.includes(agent))
    return refuse('agent_not_allowed', `${agent} is not a helper (${helpers.agentIds.join(', ')})`)
  if (args.after !== undefined || args.replaces !== undefined)
    return refuse('bad_request', 'Helper steps take no after or replaces; assign a new one instead')
  if (o.gate_policy === 'none' && args.needsApproval === true)
    return refuse('not_lead_asks', "This run's gate policy is none; leave needsApproval out")
  const rawInstruction = args.instruction as string
  if (containsCapability(rawInstruction))
    return refuse(
      'capability_in_text',
      'The instruction contains something shaped like a capability; remove it',
    )
  if (o.deadline_at !== null && now >= o.deadline_at)
    return refuse('deadline_passed', 'The run deadline has passed')
  const frozen = frozenIncarnation(sqlite, o.id, agent)
  if (
    frozen !== undefined &&
    frozen !== (lifecycleOf(sqlite, agent)?.incarnation_id ?? 'untracked')
  )
    return refuse('agent_changed', `${agent} was replaced after this run started`)
  if (!agentAdmits(sqlite, agent))
    return refuse('agent_unavailable', `${agent} is not ready for new work`)
  if (helperStepsLeft(sqlite, o.id, helpers) < 1)
    return refuse(
      'helper_limit',
      `The helpers are limited to ${helpers.maxSteps} steps in this run`,
    )
  const waiting = awaitCheckpoint(ctx, o, 'before_plan', attempt.id)
  if (waiting) return refuse(waiting.code, waiting.message)
  const view = budgetView(sqlite, o)
  if (unknownCostBlocks(sqlite, o, view))
    return refuse(
      'unknown_spend',
      'Spend of an earlier attempt is unknown; the person has to accept that first',
    )
  if (!canReserve(view, o.step_estimate_usd))
    return refuse(
      'budget_exceeded',
      `The budget has about $${(view.remainingUsd ?? 0).toFixed(2)} left`,
    )
  const instruction = `${ROLE_PREAMBLE[role]}\n\n${redact(rawInstruction)}`
  const quota = quotaRefusal(o, utf8Bytes(instruction) + 512)
  if (quota) return quota
  const gated = o.gate_policy === 'every-step' || args.needsApproval === true
  const id = insertHelperStep(ctx, o, {
    agentId: agent,
    instruction,
    role: 'helper',
    helperRole: role,
    createdIn: attempt.id,
    status: gated ? 'pending_gate' : 'queued',
  })
  let gateId: string | undefined
  if (gated) {
    const payloadText = JSON.stringify({
      agentId: agent,
      agentIncarnation: lifecycleOf(sqlite, agent)?.incarnation_id ?? 'untracked',
      instruction,
      after: [],
      replaces: null,
      estimateUsd: o.step_estimate_usd,
      dependencyRevisions: {},
      ...policyField(sqlite, o.id, agent),
    })
    gateId = `g${gatesOf(sqlite, o.id).length + 1}`
    sqlite
      .prepare(
        `INSERT INTO orc_gates (orchestration_id, id, step_id, requested_by, payload, payload_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        o.id,
        gateId,
        id,
        args.needsApproval === true ? 'lead' : 'policy',
        payloadText,
        createHash('sha256').update(payloadText).digest('hex'),
        now,
      )
    addStored(sqlite, o.id, utf8Bytes(payloadText))
  }
  return ok({
    stepId: id,
    role,
    ...(gateId ? { gateId } : {}),
    status: gated ? 'pending_gate' : 'queued',
  })
}

export const assignCommand: Handler = (ctx, o, attempt, args) => {
  if (args.role !== undefined) return assignHelper(ctx, o, attempt, args)
  const { sqlite, now } = ctx
  const agent = args.agent as string
  const rawInstruction = args.instruction as string
  const after = (args.after as string[] | undefined) ?? []
  const replaces = args.replaces as string | undefined
  const needsApproval = args.needsApproval === true
  // Under every-step the step is gated anyway, so the flag is already satisfied; refusing it only cost the lead a
  // turn in the first live run. Under `none` the person chose no gates, so asking for one stays an error.
  if (needsApproval && o.gate_policy === 'none')
    return refuse(
      'not_lead_asks',
      "This run's gate policy is none; steps start without approval, so leave needsApproval out",
    )
  if (containsCapability(rawInstruction))
    return refuse(
      'capability_in_text',
      'The instruction contains something shaped like a capability; remove it',
    )
  if (o.deadline_at !== null && now >= o.deadline_at)
    return refuse('deadline_passed', 'The run deadline has passed')
  if (agent === o.lead_agent_id || !o.allowed_agents.includes(agent))
    return refuse(
      'agent_not_allowed',
      `${agent} is not one of the allowed agents (${o.allowed_agents.join(', ')})`,
    )
  const life = lifecycleOf(sqlite, agent)
  // The run works with the agent it was started with; a replacement waits for the person's remap decision.
  const frozen = frozenIncarnation(sqlite, o.id, agent)
  if (frozen !== undefined && frozen !== (life?.incarnation_id ?? 'untracked')) {
    return refuse(
      'agent_changed',
      `${agent} was replaced after this run started; the person has to decide whether to use the new one`,
    )
  }
  if (!agentAdmits(sqlite, agent))
    return refuse('agent_unavailable', `${agent} is not ready for new work`)
  // The quota guard (8.6): a coding agent below its floor is not given a new step. The lead is told why and who else
  // has room; with `ifQuotaLow: "ask_owner"` the step is created held instead and the person decides.
  const below = quotaCheck(sqlite, ctx.quota, o, agent, Date.parse(now))
  const ifQuotaLow = args.ifQuotaLow === 'ask_owner' ? 'ask_owner' : undefined
  if (below && !ifQuotaLow) {
    const others = agentsWithRoom(sqlite, ctx.quota, o, agent, Date.parse(now))
    return {
      status: 'refused',
      code: 'quota_low',
      message: `${agent} has ${below.leftPercent}% of ${windowPhrase(below.window, below.group)} left until ${below.resetsAt}, which is under its floor. ${
        others.length
          ? `Assign the step to another agent that has room (${others.join(', ')}). `
          : 'No other allowed agent has room. '
      }If only ${agent} can do this step, call orch.assign again with ifQuotaLow: "ask_owner" and the person will decide.`,
      result: {
        agent,
        window: below.window,
        group: below.group,
        leftPercent: below.leftPercent,
        resetsAt: below.resetsAt,
        otherAgents: others,
      },
    }
  }
  // 3.27.0: a run that goes on until the person stops it has no step cap (its spend cap still holds).
  if (o.until_stopped !== 1 && o.steps_created >= o.max_steps)
    return refuse('step_limit', `The run is limited to ${o.max_steps} steps`)
  // 3.14: no work starts before the advisor has seen the plan.
  const waiting = awaitCheckpoint(ctx, o, 'before_plan', attempt.id)
  if (waiting) return refuse(waiting.code, waiting.message)
  // The advisor's consults and vote answers are Score's: the lead can't depend on or replace them.
  const steps = stepsOf(sqlite, o.id).filter((step) => !isAdvisorStep(step) && step.role !== 'vote')
  const byId = new Map(steps.map((step) => [step.id, step]))
  if (new Set(after).size !== after.length)
    return refuse('bad_dependency', 'after lists a step twice')
  for (const id of after)
    if (!byId.has(id))
      return refuse('bad_dependency', `after names ${id}, which is not a step of this run`)
  if (replaces !== undefined) {
    const target = byId.get(replaces)
    if (!target)
      return refuse('bad_replaces', `replaces names ${replaces}, which is not a step of this run`)
    if (['pending_gate', 'queued', 'admitted', 'succeeded'].includes(target.status))
      return refuse(
        'bad_replaces',
        `${replaces} is ${target.status}; only a failed, cancelled, blocked, rejected, not started or unknown step can be replaced`,
      )
    if (
      steps.some(
        (step) =>
          step.replaces === replaces &&
          step.status !== 'cancelled' &&
          step.status !== 'rejected' &&
          step.status !== 'failed' &&
          step.status !== 'blocked' &&
          step.status !== 'not_started',
      )
    )
      return refuse('bad_replaces', `${replaces} already has a replacement`)
  }
  const instruction = redact(rawInstruction)
  const view = budgetView(sqlite, o)
  if (unknownCostBlocks(sqlite, o, view))
    return refuse(
      'unknown_spend',
      'Spend of an earlier attempt is unknown; the person has to accept that first',
    )
  if (!canReserve(view, o.step_estimate_usd))
    return refuse(
      'budget_exceeded',
      `The budget has about $${(view.remainingUsd ?? 0).toFixed(2)} left; a step is estimated at $${o.step_estimate_usd.toFixed(2)}`,
    )
  const seq = o.steps_created + 1
  const id = `s${seq}`
  const policyGate = o.gate_policy === 'every-step' || needsApproval
  const payload = {
    agentId: agent,
    agentIncarnation: life?.incarnation_id ?? 'untracked',
    instruction,
    after,
    replaces: replaces ?? null,
    estimateUsd: o.step_estimate_usd,
    dependencyRevisions: Object.fromEntries(
      after.map((dep) => [dep, byId.get(dep)!.result_revision]),
    ),
    // A coding worker's approval is for the settings it was approved with (7.7b §12a).
    ...policyField(sqlite, o.id, agent),
  }
  const payloadText = JSON.stringify(payload)
  const bytes = utf8Bytes(instruction) + (policyGate ? utf8Bytes(payloadText) : 0) + 256
  const quota = quotaRefusal(o, bytes)
  if (quota) return quota
  sqlite
    .prepare(
      `INSERT INTO orc_steps (orchestration_id, id, seq, agent_id, agent_incarnation, instruction, after_steps, replaces, status, estimate_usd, created_in_attempt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.id,
      id,
      seq,
      agent,
      payload.agentIncarnation,
      instruction,
      JSON.stringify(after),
      replaces ?? null,
      policyGate ? 'pending_gate' : 'queued',
      o.step_estimate_usd,
      attempt.id,
      now,
      now,
    )
  sqlite
    .prepare('UPDATE orchestrations SET steps_created = steps_created + 1 WHERE id = ?')
    .run(o.id)
  let gateId: string | undefined
  if (policyGate) {
    gateId = `g${gatesOf(sqlite, o.id).length + 1}`
    sqlite
      .prepare(
        `INSERT INTO orc_gates (orchestration_id, id, step_id, requested_by, payload, payload_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        o.id,
        gateId,
        id,
        needsApproval ? 'lead' : 'policy',
        payloadText,
        createHash('sha256').update(payloadText).digest('hex'),
        now,
      )
  }
  addStored(sqlite, o.id, bytes)
  if (below) holdStep(ctx, o, { id, agent_id: agent }, below, { tellLead: false })
  // 3.14: the voters judge the step before it starts (it waits for their tally); not for a step the person gates.
  // A step held for its agent's low quota waits for the person, not the voters.
  const voteId =
    policyGate || below
      ? null
      : autoVoteStep(ctx, o, { id, agentId: agent, instruction }, attempt.id, (usd) =>
          canReserve(budgetView(sqlite, o), usd),
        )
  return ok({
    stepId: id,
    ...(gateId ? { gateId } : {}),
    status: policyGate ? 'pending_gate' : 'queued',
    ...(below ? { held: 'quota_low' } : {}),
    ...(voteId
      ? {
          voteId,
          note: 'The voters judge this step before it starts; their tally starts a new turn for you.',
        }
      : {}),
  })
}
