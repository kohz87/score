import {
  OrchAskArgsSchema,
  OrchAssignArgsSchema,
  OrchCancelArgsSchema,
  OrchCheckArgsSchema,
  OrchFinishArgsSchema,
  OrchNoteArgsSchema,
  OrchPlanArgsSchema,
  OrchReceiptArgsSchema,
  OrchRequestApprovalArgsSchema,
  type OrchReceipt,
} from '@score/contract'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { z } from 'zod'
import { agentAdmits, lifecycleOf } from '../agent-lifecycle.ts'
import { storeMessage } from '../rooms.ts'
import { redact } from '../../redact.ts'
import { checkConfigOf, finishRefusal, queueCheck } from './checks.ts'
import { budgetView, canReserve, unknownCostBlocks } from './budget.ts'
import { readWorkerPolicy } from './coding-policy.ts'
import { agentsWithRoom, holdStep, quotaCheck, windowPhrase } from './quota-guard.ts'
import { containsCapability, hashCapability } from './capability.ts'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import {
  addStored,
  beginFinish,
  cascadeBlocked,
  oweStop,
  refuseAttempt,
  setStepStatus,
  storageRoom,
  utf8Bytes,
  withdrawGates,
} from './ops.ts'
import {
  attemptsOf,
  frozenIncarnation,
  gatesOf,
  inquiriesOf,
  isFinalStep,
  readAttempt,
  readOrch,
  readStep,
  stepsOf,
  type AttemptRow,
  type OrchRow,
} from './store.ts'

// The `orch.*` tools (design v1-v3). A call is a command: its identity, canonical payload hash, mutation, reservations
// and receipt commit in the caller's single transaction. Refusals are receipts too (the lead can look them up).

export const TOOLS = [
  'orch.plan',
  'orch.assign',
  'orch.cancel',
  'orch.ask',
  'orch.requestApproval',
  'orch.note',
  'orch.finish',
  'orch.receipt',
  'orch.check',
] as const
export type ToolName = (typeof TOOLS)[number]

const SCHEMAS = {
  'orch.plan': OrchPlanArgsSchema,
  'orch.assign': OrchAssignArgsSchema,
  'orch.cancel': OrchCancelArgsSchema,
  'orch.ask': OrchAskArgsSchema,
  'orch.requestApproval': OrchRequestApprovalArgsSchema,
  'orch.note': OrchNoteArgsSchema,
  'orch.finish': OrchFinishArgsSchema,
  'orch.receipt': OrchReceiptArgsSchema,
  'orch.check': OrchCheckArgsSchema,
} as const

export function parseToolArgs(
  tool: ToolName,
  raw: unknown,
):
  | { ok: true; args: Record<string, unknown> & { capability: string; commandId: string } }
  | { ok: false; message: string } {
  const parsed = (SCHEMAS[tool] as z.ZodType).safeParse(raw)
  if (!parsed.success)
    return {
      ok: false,
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
        .join('; '),
    }
  return {
    ok: true,
    args: parsed.data as Record<string, unknown> & { capability: string; commandId: string },
  }
}

const ok = (result: Record<string, unknown>): OrchReceipt => ({ status: 'ok', result })
const refuse = (code: string, message: string): OrchReceipt => ({
  status: 'refused',
  code,
  message,
})

/** `{ policyId }` for a coding worker with a stored policy, nothing for a Hermes agent. */
function policyField(sqlite: DatabaseSync, orchId: string, agentId: string): { policyId?: string } {
  const stored = readWorkerPolicy(sqlite, orchId, agentId)
  return stored ? { policyId: stored.policyId } : {}
}

/** Canonical payload: keys sorted, capability and commandId excluded (they identify the call, not its content). */
export function payloadHash(tool: string, args: Record<string, unknown>): string {
  const content = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== 'capability' && key !== 'commandId'),
  )
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, sorted(child)]),
          )
        : value
  return createHash('sha256')
    .update(JSON.stringify(sorted({ tool, ...content })))
    .digest('hex')
}

export type CommandOutcome =
  | { kind: 'receipt'; receipt: OrchReceipt; changed: boolean }
  | { kind: 'unauthorized'; message: string }

const incarnationOf = (ctx: Ctx, agentId: string): string =>
  lifecycleOf(ctx.sqlite, agentId)?.incarnation_id ?? 'untracked'

/**
 * One tool call, inside the caller's transaction. `agentId` is the MCP token's agent.
 */
export function runCommand(
  ctx: Ctx,
  agentId: string,
  tool: ToolName,
  args: Record<string, unknown> & { capability: string; commandId: string },
  limits: { commandsPerAttempt: number },
): CommandOutcome {
  const { sqlite, now } = ctx
  const capability = sqlite
    .prepare('SELECT * FROM orc_capabilities WHERE hash = ?')
    .get(hashCapability(args.capability)) as
    | {
        attempt_id: string
        agent_id: string
        agent_incarnation: string
        expired_at: string | null
      }
    | undefined
  if (!capability) return { kind: 'unauthorized', message: 'unknown capability' }
  // The MCP token must belong to the lead the capability was issued to, in the incarnation it was issued for.
  if (capability.agent_id !== agentId)
    return { kind: 'unauthorized', message: 'this capability belongs to another agent' }
  if (incarnationOf(ctx, agentId) !== capability.agent_incarnation || !agentAdmits(sqlite, agentId))
    return {
      kind: 'unauthorized',
      message: 'the lead agent changed since this capability was issued',
    }
  const attempt = readAttempt(sqlite, capability.attempt_id)
  if (!attempt) return { kind: 'unauthorized', message: 'unknown capability' }
  if (capability.expired_at !== null || attempt.retired)
    return { kind: 'unauthorized', message: 'this capability has expired (stale generation)' }
  if (attempt.state === 'send_started')
    // Admission of this lead attempt is not recorded yet: nothing is stored, the same commandId may be sent again.
    return {
      kind: 'receipt',
      changed: false,
      receipt: {
        status: 'retry',
        code: 'admission_pending',
        message: 'Score has not recorded this turn yet; send the same call again in a moment',
        commandId: args.commandId,
        tool,
      },
    }
  if (attempt.state !== 'running')
    return { kind: 'unauthorized', message: 'this capability has expired (the turn is over)' }
  const o = readOrch(sqlite, attempt.orchestration_id)
  if (!o) return { kind: 'unauthorized', message: 'unknown capability' }
  // The turn is over as soon as Hermes says its run ended, not only once the executor has reconciled it.
  const ended = attempt.run_id
    ? (sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(attempt.run_id) as
        { status: string } | undefined)
    : undefined
  if (ended && ['completed', 'failed', 'cancelled', 'interrupted'].includes(ended.status)) {
    sqlite
      .prepare('UPDATE orc_capabilities SET expired_at = ? WHERE hash = ? AND expired_at IS NULL')
      .run(now, hashCapability(args.capability))
    return { kind: 'unauthorized', message: 'this capability has expired (the turn is over)' }
  }

  const stored = sqlite
    .prepare(
      'SELECT tool, payload_hash, receipt FROM orc_commands WHERE attempt_id = ? AND command_id = ?',
    )
    .get(attempt.id, args.commandId) as
    { tool: string; payload_hash: string; receipt: string } | undefined

  if (tool === 'orch.receipt') {
    const lookup = args.commandId
    const row = sqlite
      .prepare('SELECT receipt FROM orc_commands WHERE attempt_id = ? AND command_id = ?')
      .get(attempt.id, lookup) as { receipt: string } | undefined
    return {
      kind: 'receipt',
      changed: false,
      receipt: row
        ? (JSON.parse(row.receipt) as OrchReceipt)
        : {
            status: 'not_found',
            commandId: lookup,
            tool,
            message: 'No stored command with that id in this turn',
          },
    }
  }

  const hash = payloadHash(tool, args)
  if (stored) {
    if (stored.tool === tool && stored.payload_hash === hash)
      return { kind: 'receipt', changed: false, receipt: JSON.parse(stored.receipt) as OrchReceipt }
    return {
      kind: 'receipt',
      changed: false,
      receipt: {
        status: 'conflict',
        code: 'command_id_reused',
        commandId: args.commandId,
        tool,
        message: 'That commandId was already used for a different call',
      },
    }
  }
  if (attempt.commands >= limits.commandsPerAttempt)
    return {
      kind: 'receipt',
      changed: false,
      receipt: {
        status: 'refused',
        code: 'command_limit',
        commandId: args.commandId,
        tool,
        message: `At most ${limits.commandsPerAttempt} commands per lead turn`,
      },
    }

  let receipt: OrchReceipt
  if (o.finish_requested_at !== null)
    receipt = refuse('sealed', 'The run has a finish request; no further commands are accepted')
  else if (o.status !== 'running' && o.status !== 'paused')
    receipt = refuse('not_running', `The run is ${o.status}`)
  else receipt = HANDLERS[tool](ctx, o, attempt, args)

  const full: OrchReceipt = { ...receipt, commandId: args.commandId, tool }
  const text = JSON.stringify(full)
  sqlite
    .prepare(
      'INSERT INTO orc_commands (attempt_id, command_id, orchestration_id, tool, payload_hash, receipt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(attempt.id, args.commandId, o.id, tool, hash, text, now)
  sqlite.prepare('UPDATE orc_attempts SET commands = commands + 1 WHERE id = ?').run(attempt.id)
  addStored(sqlite, o.id, utf8Bytes(text))
  touch(ctx, o.id)
  return { kind: 'receipt', receipt: full, changed: true }
}

type Args = Record<string, unknown> & { capability: string; commandId: string }
type Handler = (ctx: Ctx, o: OrchRow, attempt: AttemptRow, args: Args) => OrchReceipt

const quotaRefusal = (o: OrchRow, bytes: number): OrchReceipt | undefined =>
  bytes > storageRoom(o)
    ? refuse('quota', "This run's storage allowance is used up; finish or stop the run")
    : undefined

const HANDLERS: Record<ToolName, Handler> = {
  'orch.plan'(ctx, o, _attempt, args) {
    const entries = (args.entries as string[]).map((entry) => redact(entry))
    const bytes = utf8Bytes(JSON.stringify(entries))
    const quota = quotaRefusal(o, bytes)
    if (quota) return quota
    ctx.sqlite
      .prepare('UPDATE orchestrations SET plan = ? WHERE id = ?')
      .run(JSON.stringify(entries), o.id)
    addStored(ctx.sqlite, o.id, bytes)
    return ok({ entries: entries.length })
  },

  'orch.assign'(ctx, o, attempt, args) {
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
    if (o.steps_created >= o.max_steps)
      return refuse('step_limit', `The run is limited to ${o.max_steps} steps`)
    const steps = stepsOf(sqlite, o.id)
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
    return ok({
      stepId: id,
      ...(gateId ? { gateId } : {}),
      status: policyGate ? 'pending_gate' : 'queued',
      ...(below ? { held: 'quota_low' } : {}),
    })
  },

  'orch.requestApproval'(ctx, o, _attempt, args) {
    const { sqlite, now } = ctx
    if (o.gate_policy !== 'lead-asks')
      return refuse(
        'not_lead_asks',
        `This run's gate policy is ${o.gate_policy}; approval requests only exist under lead-asks`,
      )
    const stepId = args.stepId as string
    const step = readStep(sqlite, o.id, stepId)
    if (!step) return refuse('unknown_step', `${stepId} is not a step of this run`)
    if (attemptsOf(sqlite, o.id).some((x) => x.step_id === stepId))
      return refuse(
        'already_admitted',
        `${stepId} has already been admitted; approval is requested in orch.assign (needsApproval) before it can start`,
      )
    if (step.status !== 'queued')
      return refuse(
        'not_queued',
        `${stepId} is ${step.status}; approval can only be requested for a queued step that has not started`,
      )
    if (
      gatesOf(sqlite, o.id).some((gate) => gate.step_id === stepId && gate.status !== 'withdrawn')
    )
      return refuse('gate_exists', `${stepId} already has a gate`)
    const byId = new Map(stepsOf(sqlite, o.id).map((s) => [s.id, s]))
    const payload = {
      agentId: step.agent_id,
      agentIncarnation: step.agent_incarnation,
      instruction: step.instruction,
      after: step.after_steps,
      replaces: step.replaces,
      estimateUsd: step.estimate_usd,
      dependencyRevisions: Object.fromEntries(
        step.after_steps.map((dep) => [dep, byId.get(dep)?.result_revision ?? 0]),
      ),
      ...policyField(sqlite, o.id, step.agent_id),
    }
    const text = JSON.stringify(payload)
    const quota = quotaRefusal(o, utf8Bytes(text))
    if (quota) return quota
    const gateId = `g${gatesOf(sqlite, o.id).length + 1}`
    sqlite
      .prepare(
        `INSERT INTO orc_gates (orchestration_id, id, step_id, requested_by, payload, payload_hash, status, created_at)
         VALUES (?, ?, ?, 'lead', ?, ?, 'open', ?)`,
      )
      .run(o.id, gateId, stepId, text, createHash('sha256').update(text).digest('hex'), now)
    setStepStatus(sqlite, o.id, stepId, 'pending_gate', null, now)
    addStored(sqlite, o.id, utf8Bytes(text))
    return ok({ gateId, stepId })
  },

  'orch.cancel'(ctx, o, _attempt, args) {
    const { sqlite, now } = ctx
    const stepId = args.stepId as string
    const step = readStep(sqlite, o.id, stepId)
    if (!step) return refuse('unknown_step', `${stepId} is not a step of this run`)
    if (isFinalStep(step.status) || step.retired)
      return refuse('already_final', `${stepId} is already ${step.status}`)
    const attempt = attemptsOf(sqlite, o.id).findLast((a) => a.step_id === stepId)
    let fence = false
    if (step.status === 'admitted' || step.status === 'unknown') {
      if (attempt && attempt.state === 'created')
        refuseAttempt(sqlite, attempt, 'cancelled before it was sent', now)
      else if (attempt && ['send_started', 'running', 'unknown'].includes(attempt.state)) {
        oweStop(sqlite, attempt, now)
        // The stop is journaled before this transaction commits (a restored database that lost it is detected).
        journalSoft(ctx, () =>
          ctx.journal.append({
            kind: 'stop_fence',
            orchestrationId: o.id,
            attemptId: attempt.id,
            reason: `cancel:${stepId}`,
          }),
        )
        fence = true
      }
    }
    setStepStatus(sqlite, o.id, stepId, 'cancelled', 'cancelled by the lead', now)
    sqlite
      .prepare('UPDATE orc_steps SET retired = 1 WHERE orchestration_id = ? AND id = ?')
      .run(o.id, stepId)
    withdrawGates(sqlite, o.id, now, stepId)
    cascadeBlocked(sqlite, o.id, now)
    return ok({ stepId, status: 'cancelled', admitted: fence, admissionsFenced: fence })
  },

  'orch.ask'(ctx, o, attempt, args) {
    const { sqlite, now } = ctx
    const question = redact(args.question as string)
    const open = inquiriesOf(sqlite, o.id).filter((inquiry) => inquiry.status === 'open')
    if (open.length >= 3)
      return refuse('too_many_questions', 'Three questions are already waiting for the person')
    const quota = quotaRefusal(o, utf8Bytes(question) + 128)
    if (quota) return quota
    const id = `q${inquiriesOf(sqlite, o.id).length + 1}`
    sqlite
      .prepare(
        `INSERT INTO orc_inquiries (orchestration_id, id, attempt_id, question, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)`,
      )
      .run(o.id, id, attempt.id, question, now)
    addStored(sqlite, o.id, utf8Bytes(question) + 128)
    return ok({ inquiryId: id })
  },

  'orch.note'(ctx, o, attempt, args) {
    const text = redact(args.text as string)
    const quota = quotaRefusal(o, utf8Bytes(text) + 256)
    if (quota) return quota
    const id = `orc-note:${attempt.id}:${args.commandId}`
    ctx.events.push(
      ...storeMessage(
        ctx.sqlite,
        {
          id,
          roomId: o.room_id,
          author: { kind: 'agent', agentId: attempt.agent_id },
          to: [],
          parts: [{ kind: 'text', text, via: 'mcp' }],
          createdAt: ctx.now,
          streaming: false,
          refs: [],
        },
        ctx.now,
      ),
    )
    addStored(ctx.sqlite, o.id, utf8Bytes(text) + 256)
    return ok({ messageId: id })
  },

  'orch.check'(ctx, o) {
    if (checkConfigOf(ctx.sqlite, o.id) === null)
      return refuse(
        'no_check',
        'This job has no check. Only the person can set one, when the job starts.',
      )
    const checkId = queueCheck(ctx, o.id, 'lead')
    return ok({ checkId, note: 'Queued. Its result starts a new turn for you; end this turn.' })
  },

  'orch.finish'(ctx, o, attempt, args) {
    const outcome = args.outcome as 'success' | 'partial' | 'failed'
    // 3.13: the oracle. A successful finish needs a current pass (or the person's waiver).
    const refusal = outcome === 'success' ? finishRefusal(ctx.sqlite, o) : null
    if (refusal) return refuse(refusal.code, refusal.message)
    const summary = redact(args.summary as string)
    const retired = beginFinish(ctx, o, attempt.id, outcome, summary)
    return ok({ finishing: true, retiredSteps: retired })
  },

  'orch.receipt'() {
    return refuse('internal', 'handled before dispatch')
  },
}
