import type { PolicyRemapDecision, RemapDecision } from '@score/contract'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { HttpError } from '../../errors.ts'
import { lifecycleOf } from '../agent-lifecycle.ts'
import { readWorkerPolicy, storeWorkerPolicy } from './coding-policy.ts'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import { expectRevision, mustBeLive } from './decision-guards.ts'
import { addStored, bumpAdmission, setStepStatus, utf8Bytes } from './ops.ts'
import {
  addCause,
  addHistory,
  attemptsOf,
  frozenIncarnation,
  gatesOf,
  readStep,
  requireOrch,
  stepsOf,
} from './store.ts'
import {
  forbiddenPermissionError,
  isForbiddenPermission,
  type WorkerReport,
} from './supported-agents.ts'

/**
 * A coding worker's replacement is approved by its new policy id and its reach, like a worker at the start (7.7b §12a): the
 * agent must be ready, the request must name the policy id it is now, and a reach beyond the workspace needs the
 * acknowledgement of exactly that id. Stores the new policy. A no-op for an agent that isn't a coding worker of the run.
 * Shared by the orchestration remap and the workflow remap (7.7c).
 */
export function acceptCodingRemap(
  sqlite: DatabaseSync,
  orchId: string,
  body: Pick<RemapDecision, 'agentId' | 'policyId' | 'acknowledgeCodingReach'>,
  report: WorkerReport | undefined,
  now: string,
): void {
  if (!readWorkerPolicy(sqlite, orchId, body.agentId)) return
  if (!report || report.readiness !== 'ready' || !report.policy || report.policyId === null)
    throw new HttpError(
      409,
      'conflict',
      `${body.agentId} isn’t ready: ${report?.detail ?? 'Score couldn’t check it'}.`,
    )
  // The same rule as at create: a remap can't carry a coding worker to a permission it may not have (7.7c F1 #1).
  if (isForbiddenPermission(report.policy.permission))
    throw forbiddenPermissionError([body.agentId])
  if (body.policyId !== report.policyId)
    throw new HttpError(
      409,
      'policy_changed',
      `${body.agentId} changed again. Look at what it can reach and decide again.`,
      { agentId: body.agentId, currentPolicyId: report.policyId },
    )
  if (
    report.reachBeyondWorkspace &&
    !body.acknowledgeCodingReach?.policyIds.includes(report.policyId)
  )
    throw new HttpError(
      409,
      'reach_not_acknowledged',
      `${body.agentId} can read beyond its workspace. Accept that to use it.`,
      { agentId: body.agentId, policyId: report.policyId },
    )
  storeWorkerPolicy(
    sqlite,
    orchId,
    body.agentId,
    {
      policyId: report.policyId,
      policy: report.policy,
      reach: report.reach!,
      reachBeyondWorkspace: report.reachBeyondWorkspace,
      acknowledged: report.reachBeyondWorkspace,
    },
    now,
  )
  if (report.reachBeyondWorkspace)
    addHistory(sqlite, orchId, 'coding_reach_acknowledged', { policyIds: [report.policyId] }, now)
}

/**
 * "Use the new <agent> for this run": the person's answer to a replaced agent. Paired with the exact frozen and current
 * incarnations the page showed; anything else is a conflict (the agent was replaced again, or the run was remapped). Steps
 * assigned under the old mapping stay blocked: the lead assigns again under the new one.
 */
export function remapAgent(
  ctx: Ctx,
  orchId: string,
  body: RemapDecision,
  report?: WorkerReport,
): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const frozen = frozenIncarnation(sqlite, orchId, body.agentId)
  if (frozen === undefined)
    throw new HttpError(404, 'not_found', `${body.agentId} is not an agent of this run.`)
  const current = lifecycleOf(sqlite, body.agentId)?.incarnation_id ?? 'untracked'
  if (
    frozen !== body.frozenIncarnation ||
    current !== body.currentIncarnation ||
    current === 'untracked'
  )
    throw new HttpError(409, 'conflict', `${body.agentId} changed again. Look at the run again.`)
  if (frozen === current) throw new HttpError(409, 'conflict', `${body.agentId} was not replaced.`)
  acceptCodingRemap(sqlite, orchId, body, report, now)
  // The journal entry comes first: a database that later lacks this remap is detected at start.
  journalSoft(ctx, () =>
    ctx.journal.append({
      kind: 'remap',
      orchestrationId: orchId,
      agentId: body.agentId,
      incarnation: current,
    }),
  )
  sqlite
    .prepare(
      'UPDATE orc_agent_map SET incarnation = ?, updated_at = ? WHERE orchestration_id = ? AND agent_id = ?',
    )
    .run(current, now, orchId, body.agentId)
  if (body.agentId === o.lead_agent_id) {
    sqlite
      .prepare('UPDATE orchestrations SET lead_incarnation = ? WHERE id = ?')
      .run(current, orchId)
    // The pause this replacement caused ends with the decision about it; admission re-pauses if something else applies.
    // Only that condition goes: a manual hold that is still there keeps the run paused, now for its own reason.
    if (o.status === 'paused' && o.pause_reason === 'agent_unavailable')
      sqlite
        .prepare(
          o.manual_paused_at !== null
            ? "UPDATE orchestrations SET pause_reason = 'person' WHERE id = ?"
            : "UPDATE orchestrations SET status = 'running', pause_reason = NULL WHERE id = ?",
        )
        .run(orchId)
  }
  addHistory(
    sqlite,
    orchId,
    'agent_remapped',
    { agentId: body.agentId, from: frozen, to: current },
    now,
  )
  // The lead learns of it (an assignment it was refused may now succeed).
  addCause(sqlite, orchId, 'agent_remapped', body.agentId, now)
  bumpAdmission(sqlite)
  touch(ctx, orchId)
}

/**
 * "Use the new settings" (7.7b §12a): a step blocked `agent_changed` takes the SAME coding agent's current policy. The
 * decision is bound to the policy id the person saw and, when the reach goes beyond the workspace, to an acknowledgement
 * of that exact id. A gate approved for the old id is withdrawn and the step returns to `pending_gate` for a fresh
 * approval; without a gate the step is queued again. Either way admission re-admits the step's one suspended attempt.
 */
export function policyRemapStep(
  ctx: Ctx,
  orchId: string,
  stepId: string,
  body: PolicyRemapDecision,
  report: WorkerReport | undefined,
): void {
  const { sqlite, now } = ctx
  const o = requireOrch(sqlite, orchId)
  expectRevision(o, body.orchestrationRevision)
  mustBeLive(o)
  const step = readStep(sqlite, orchId, stepId)
  if (!step) throw new HttpError(404, 'not_found', 'Couldn’t find that step.')
  if (step.agent_id !== body.agentId)
    throw new HttpError(409, 'conflict', `${body.agentId} isn’t the agent of this step.`)
  // Only the step's current attempt: unsent, suspended and not retired (a renewal's predecessor is none of these).
  const suspended = attemptsOf(sqlite, orchId).findLast(
    (attempt) =>
      attempt.step_id === stepId &&
      attempt.suspended &&
      attempt.state === 'created' &&
      !attempt.retired,
  )
  if (
    step.status !== 'blocked' ||
    !['agent_changed', 'permission_forbidden'].includes(step.disposition ?? '') ||
    !suspended
  )
    throw new HttpError(409, 'conflict', 'This step isn’t waiting for new settings.')
  const stored = readWorkerPolicy(sqlite, orchId, body.agentId)
  if (!stored) throw new HttpError(409, 'conflict', `${body.agentId} has no settings in this run.`)
  if (!report || report.readiness !== 'ready' || !report.policy || report.policyId === null)
    throw new HttpError(
      409,
      'conflict',
      `${body.agentId} isn’t ready: ${report?.detail ?? 'Score couldn’t check it'}.`,
    )
  if (isForbiddenPermission(report.policy.permission))
    throw forbiddenPermissionError([body.agentId])
  if (report.policyId !== body.policyId)
    throw new HttpError(
      409,
      'policy_changed',
      `${body.agentId} changed again. Look at what it can reach and decide again.`,
      { agentId: body.agentId, currentPolicyId: report.policyId },
    )
  // Each suspended attempt carries the settings its own step was approved with. The agent's stored mapping may already
  // have moved on (another step of the same worker was remapped first), and this step still needs its own decision (F1 #4).
  if ((suspended.policy_id ?? stored.policyId) === body.policyId)
    throw new HttpError(
      409,
      'conflict',
      `${body.agentId} still has the settings this step was approved with.`,
    )
  if (
    report.reachBeyondWorkspace &&
    !body.acknowledgeCodingReach?.policyIds.includes(body.policyId)
  )
    throw new HttpError(
      409,
      'reach_not_acknowledged',
      `${body.agentId} can read beyond its workspace. Accept that to use the new settings.`,
      { agentId: body.agentId, policyId: body.policyId },
    )
  // The journal entry comes first: a database that later lacks this decision is detected at start.
  journalSoft(ctx, () =>
    ctx.journal.append({
      kind: 'policy_remap',
      orchestrationId: orchId,
      stepId,
      agentId: body.agentId,
      policyId: body.policyId,
    }),
  )
  storeWorkerPolicy(
    sqlite,
    orchId,
    body.agentId,
    {
      policyId: body.policyId,
      policy: report.policy,
      reach: report.reach!,
      reachBeyondWorkspace: report.reachBeyondWorkspace,
      acknowledged: body.acknowledgeCodingReach?.policyIds.includes(body.policyId) ?? false,
    },
    now,
  )
  if (report.reachBeyondWorkspace)
    addHistory(
      sqlite,
      orchId,
      'coding_reach_acknowledged',
      { policyIds: [body.policyId], stepId },
      now,
    )
  // The step's own attempt now carries the settings this decision approved (F2 #3).
  sqlite
    .prepare('UPDATE orc_attempts SET policy_id = ?, updated_at = ? WHERE id = ?')
    .run(body.policyId, now, suspended.id)
  const hadGate = gatesOf(sqlite, orchId).some((gate) => gate.step_id === stepId)
  // A gate approved (or still open) for the old settings no longer covers the step.
  sqlite
    .prepare(
      "UPDATE orc_gates SET status = 'withdrawn', revision = revision + 1, decided_at = ? WHERE orchestration_id = ? AND step_id = ? AND status IN ('open', 'approved')",
    )
    .run(now, orchId, stepId)
  if (hadGate || o.gate_policy === 'every-step') {
    const byId = new Map(stepsOf(sqlite, orchId).map((candidate) => [candidate.id, candidate]))
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
      policyId: body.policyId,
    }
    const text = JSON.stringify(payload)
    sqlite
      .prepare(
        `INSERT INTO orc_gates (orchestration_id, id, step_id, requested_by, payload, payload_hash, status, created_at)
         VALUES (?, ?, ?, 'policy', ?, ?, 'open', ?)`,
      )
      .run(
        orchId,
        `g${gatesOf(sqlite, orchId).length + 1}`,
        stepId,
        text,
        createHash('sha256').update(text).digest('hex'),
        now,
      )
    addStored(sqlite, orchId, utf8Bytes(text))
    setStepStatus(sqlite, orchId, stepId, 'pending_gate', null, now)
  } else setStepStatus(sqlite, orchId, stepId, 'queued', null, now)
  addHistory(
    sqlite,
    orchId,
    'policy_remapped',
    { stepId, agentId: body.agentId, from: stored.policyId, to: body.policyId },
    now,
  )
  addCause(sqlite, orchId, 'policy_remapped', stepId, now)
  bumpAdmission(sqlite)
  touch(ctx, orchId)
}
