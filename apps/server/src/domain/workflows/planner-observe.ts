import { WORKFLOW_LIMITS } from '@score/contract'
import { addCodingStored, refuseAttempt, setStepStatus, utf8Bytes } from '../orchestration/ops.ts'
import type { AttemptRow, StepRow } from '../orchestration/store.ts'
import { defOf, emit, failRun, setState, type Pass } from './planner-context.ts'
import { readResult, type WfNodeRow } from './store.ts'
import { resultFacts } from './verdict.ts'
import { withdrawGraphEvidence } from './withdraw.ts'

// -------------------------------------------------------------------------------------------- observing the steps

/** The last executor step the node has, if any. */
export function currentStep(p: Pass, nodeId: string): StepRow | undefined {
  const rows = p.lineage.filter((l) => l.node_id === nodeId)
  const last = rows.at(-1)
  return last ? p.steps.get(last.step_id) : undefined
}
export const lastAttemptOf = (p: Pass, stepId: string): AttemptRow | undefined =>
  p.attempts
    .filter((a) => a.step_id === stepId)
    .reduce<AttemptRow | undefined>((b, a) => (!b || a.n > b.n ? a : b), undefined)

function onAgentSuccess(p: Pass, node: WfNodeRow, step: StepRow): void {
  const attempt = lastAttemptOf(p, step.id)
  const coding = attempt !== undefined && attempt.runtime !== 'hermes'
  // A coding attempt's facts are the current dispatch generation's (7.7c §3).
  const stored = attempt
    ? readResult(p.ctx.sqlite, attempt.id, coding ? attempt.dispatch_generation : undefined)
    : undefined
  if (coding) {
    // The verdict was read from the raw eligible reply when the run ended. No row: no eligible reply, no answer. Over the
    // verdict input limit: the answer is too long to read, and no prefix is ever parsed.
    if (!stored) return onAgentFailure(p, node, 'no final answer', true)
    if (stored.too_long) return onAgentFailure(p, node, 'answer too long to read a verdict', true)
    // The node keeps its own copy of the output: coding inventory, charged to the run's coding partition (§5).
    addCodingStored(p.ctx.sqlite, p.o.id, utf8Bytes(stored.output))
  }
  let output = stored?.output ?? step.result ?? ''
  let truncated = stored?.truncated ?? false
  let verdict = stored?.verdict ?? null
  if (!stored) {
    // No complete-reply facts: parse only a reply that the 8 KiB run record cannot have cut.
    const complete = utf8Bytes(step.result ?? '') < 8000
    const facts = resultFacts(step.result ?? '')
    output = facts.output
    truncated = !complete
    verdict = complete && facts.verdict ? JSON.stringify(facts.verdict) : null
  }
  setState(p, node.node_id, 'succeeded', {
    output,
    output_truncated: truncated ? 1 : 0,
    output_revision: step.result_revision,
    verdict,
    reason: null,
  })
  emit(p, node.node_id, ['ok'], 'ok', node.attempts_used)
}

export function onAgentFailure(p: Pass, node: WfNodeRow, reason: string, retryable: boolean): void {
  const def = defOf(p, node.node_id)
  if (retryable && node.attempts_used < node.attempts_max) {
    setState(p, node.node_id, 'ready', {
      reason: `try ${node.attempts_used} failed: ${reason}; retrying`,
      step_id: null,
    })
    return
  }
  setState(p, node.node_id, 'failed', { reason, output: null })
  if (def.kind === 'agent' && def.onFailure === 'route')
    emit(p, node.node_id, ['failed'], 'failed', node.attempts_used)
  else failRun(p, node.node_id, `${node.node_id} failed: ${reason}`)
}

/**
 * A step that never started because its inputs were withdrawn (7.7a/7.7b: judged at send and again at the release): the
 * node is unresolved. For a coding step nothing ran, so the try it used is given back and the person can re-run the
 * upstream step and retry this one, even with no retries configured.
 */
function unresolvedWithdrawn(p: Pass, node: WfNodeRow, step: StepRow, reason: string): void {
  const attempt = lastAttemptOf(p, step.id)
  const coding = attempt !== undefined && attempt.runtime !== 'hermes'
  setState(p, node.node_id, 'unresolved', {
    reason,
    ...(coding ? { attempts_used: Math.max(0, node.attempts_used - 1) } : {}),
  })
}

/** What the node says while its coding step waits for the person, by the step's disposition. */
const CODING_HOLD_REASON: Record<string, string> = {
  agent_changed: 'waiting for your decision about the changed agent',
  permission_forbidden: 'waiting for you: the agent has full access, which steps can’t use',
  coding_limit: 'waiting for a higher coding step limit',
  held_back: 'its start was held back 20 times: waiting for you to try again',
}

/** A blocked coding step that still has its one suspended attempt: it waits for a decision and is never replaced. */
function heldCodingStep(p: Pass, step: StepRow): boolean {
  return (
    step.status === 'blocked' &&
    CODING_HOLD_REASON[step.disposition ?? ''] !== undefined &&
    p.attempts.some((a) => a.step_id === step.id && a.suspended)
  )
}

export function observe(p: Pass): boolean {
  let changed = false
  for (const node of p.nodes.values()) {
    if (node.kind !== 'agent') continue
    // A node that already resolved is checked against its step too: a withdrawn result is no longer a success.
    if (node.state === 'succeeded') {
      const step = currentStep(p, node.node_id)
      if (step && step.status !== 'succeeded' && ['unknown', 'failed'].includes(step.status)) {
        setState(p, node.node_id, 'unresolved', {
          reason: 'its result was withdrawn: not confirmed ended',
        })
        withdrawGraphEvidence(p.ctx, p.o.id, node.node_id, 'was withdrawn')
        changed = true
      }
      continue
    }
    if (!['running', 'gate_open', 'ready'].includes(node.state) || node.step_id === null) continue
    const step = p.steps.get(node.step_id)
    if (!step) continue
    switch (step.status) {
      case 'pending_gate':
        if (node.state !== 'gate_open') {
          setState(p, node.node_id, 'gate_open', { reason: 'waiting for your approval' })
          changed = true
        }
        break
      case 'queued':
      case 'admitted':
      case 'unknown':
        // A reason left by a coding block ("waiting for new settings") ends when the step is admitted again.
        if (node.state !== 'running' || node.reason !== null) {
          setState(p, node.node_id, 'running', { reason: null })
          changed = true
        }
        break
      case 'succeeded':
        onAgentSuccess(p, node, step)
        changed = true
        break
      case 'failed': {
        const attempt = lastAttemptOf(p, step.id)
        if (attempt?.state === 'abandoned') {
          // Administrative: never a failed token. The person retries or stops.
          setState(p, node.node_id, 'unresolved', {
            reason: 'stopped waiting: not confirmed as ended',
            step_id: step.id,
          })
        } else onAgentFailure(p, node, step.disposition ?? 'the step failed', true)
        changed = true
        break
      }
      case 'rejected':
        onAgentFailure(p, node, 'the assignment was rejected', false)
        changed = true
        break
      case 'blocked': {
        const why = step.disposition ?? ''
        if (heldCodingStep(p, step)) {
          // A coding step blocked for a decision of the person (new settings, the step limit) keeps its node's binding
          // (7.7c §4): the node never lets go of the step, and the planner never assigns a replacement. Only the matching
          // decision admits THAT suspended attempt again.
          // Renewals are bounded (7.7c §4): past the last one the node fails, it doesn't wait for ever.
          if (why === 'held_back' && node.renewals >= WORKFLOW_LIMITS.maxRenewalsPerNode) {
            for (const held of p.attempts.filter(
              (a) => a.step_id === step.id && a.suspended && a.state === 'created',
            ))
              refuseAttempt(p.ctx.sqlite, held, 'not dispatched: kept being held back', p.ctx.now)
            setStepStatus(
              p.ctx.sqlite,
              p.o.id,
              step.id,
              'failed',
              'kept being held back',
              p.ctx.now,
            )
            onAgentFailure(p, node, 'kept being held back', false)
            changed = true
            break
          }
          const reason = CODING_HOLD_REASON[why]!
          if (node.state !== 'running' || node.reason !== reason) {
            setState(p, node.node_id, 'running', { reason })
            changed = true
          }
          break
        }
        if (/^input_withdrawn/.test(why)) unresolvedWithdrawn(p, node, step, why)
        else if (/^capability_in_input/.test(why)) onAgentFailure(p, node, why, false)
        else
          // agent_changed / agent_unavailable: the node waits for the person's remap; no logical attempt is used.
          setState(p, node.node_id, 'ready', { reason: why, step_id: null })
        changed = true
        break
      }
      case 'not_started':
      case 'cancelled':
        // A remapped step is re-created; one retired by Stop / Finish stays as it is.
        if (/remapped/.test(step.disposition ?? '') && p.canIssue) {
          setState(p, node.node_id, 'ready', { reason: 'remapped', step_id: null })
          changed = true
        } else if (step.status === 'cancelled' && step.disposition === 'inputs_withdrawn') {
          // A coding step refused at the release because what it was going to read was withdrawn: the node is unresolved
          // with its own Needs-you item, never left running (7.7c §4, X6). Stop, cancel and the deadline keep the run's
          // own terminal behaviour (the node ends cancelled with the run).
          unresolvedWithdrawn(
            p,
            node,
            step,
            'something this step was going to read was withdrawn before it started',
          )
          changed = true
        }
        break
    }
  }
  return changed
}
