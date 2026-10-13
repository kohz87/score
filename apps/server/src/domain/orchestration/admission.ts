import type { DatabaseSync } from 'node:sqlite'
import { agentAdmits, agentPausedAt, lifecycleOf } from '../agent-lifecycle.ts'
import { teamPausedAt } from '../team-pause.ts'
import { policyBindingProblem } from './coding-policy.ts'
import { budgetView, overBudget, unknownCostBlocks } from './budget.ts'
import { isFenced } from './fence.ts'
import {
  attemptsOf,
  frozenIncarnation,
  isTerminalStatus,
  readStep,
  stepsOf,
  type AttemptRow,
  type OrchRow,
} from './store.ts'
import { cancelFenceAttempts, unknownFenceAttempts } from './views.ts'

/** Whether the step's latest attempt ended on recovered session text and was never confirmed ended. */
export function recoveredOnly(attempts: AttemptRow[], stepId: string): boolean {
  const last = attempts
    .filter((a) => a.step_id === stepId)
    .reduce<AttemptRow | undefined>((best, a) => (!best || a.n > best.n ? a : best), undefined)
  return (
    last !== undefined &&
    last.unknown_reason === 'recovered_text_only' &&
    ['unknown', 'abandoned'].includes(last.state)
  )
}

/** The result revisions a step's input was built from (recorded at claim); undefined for an attempt claimed before. */
function frozenRevisions(
  sqlite: DatabaseSync,
  attemptId: string,
): Record<string, number> | undefined {
  const row = sqlite
    .prepare(
      "SELECT detail FROM orc_history WHERE kind = 'step_input_frozen' AND json_extract(detail, '$.attemptId') = ? ORDER BY id DESC LIMIT 1",
    )
    .get(attemptId) as { detail: string } | undefined
  if (!row) return undefined
  return (JSON.parse(row.detail) as { revisions?: Record<string, number> }).revisions
}

/**
 * Why an unsent step attempt's input is no longer usable (fix-j 2): a result it consumed is not a current success, only
 * ever ended on recovered text, or is at another revision than the one frozen into the input.
 */
export function inputWithdrawn(
  sqlite: DatabaseSync,
  orchId: string,
  attempt: AttemptRow,
): string | undefined {
  if (attempt.kind !== 'step' || !attempt.step_id) return undefined
  const step = readStep(sqlite, orchId, attempt.step_id)
  if (!step) return undefined
  const steps = stepsOf(sqlite, orchId)
  const attempts = attemptsOf(sqlite, orchId)
  // A workflow step has no `after`: what it consumed is recorded in `wf_consumed` and judged here at send (fix J, 7.1).
  const consumed = sqlite
    .prepare(
      'SELECT producer, producer_step, output_revision, kind, withdrawn FROM wf_consumed WHERE orchestration_id = ? AND step_id = ?',
    )
    .all(orchId, step.id) as {
    producer: string
    producer_step: string
    output_revision: number
    kind: string
    withdrawn: number
  }[]
  for (const c of consumed) {
    if (c.withdrawn === 1) return `${c.producer}'s result was withdrawn`
    if (c.kind === 'default') continue
    const producer = sqlite
      .prepare(
        'SELECT state, output_revision FROM wf_nodes WHERE orchestration_id = ? AND node_id = ?',
      )
      .get(orchId, c.producer) as { state: string; output_revision: number } | undefined
    if (!producer || !['succeeded', 'failed'].includes(producer.state))
      return `${c.producer} is no longer a resolved result`
    if (producer.output_revision !== c.output_revision)
      return `${c.producer} changed after this step's input was built`
    const producerStep = steps.find((s) => s.id === c.producer_step)
    if (producerStep && c.kind === 'output' && recoveredOnly(attempts, producerStep.id))
      return `${c.producer} only ended on recovered text`
  }
  const frozen = frozenRevisions(sqlite, attempt.id)
  for (const dep of step.after_steps) {
    const current = steps.find((s) => s.id === dep)
    if (!current || current.status !== 'succeeded' || current.result === null)
      return `${dep} is no longer a successful result`
    if (recoveredOnly(attempts, dep)) return `${dep} only ended on recovered text`
    if (frozen && frozen[dep] !== undefined && frozen[dep] !== current.result_revision)
      return `${dep} changed after this step's input was built`
  }
  return undefined
}

/** Why an attempt may not be sent or released now. The same causes name the cause table of 7.7b §6. */
export type AdmissionCause =
  | 'retired'
  | 'owed_stop'
  | 'cancel'
  | 'stop'
  | 'inputs_withdrawn'
  | 'deadline'
  | 'paused'
  | 'frozen'
  | 'fenced'
  | 'hold'
  | 'agent_changed'
  | 'budget'
  | 'unknown_cost'

export interface AdmissionDenial {
  cause: AdmissionCause
  /** `inputs_withdrawn`: which consumed result is no longer usable. */
  withdrawn?: string
  /** `agent_changed`: the run's frozen mapping, not the live agent row, is what differs. */
  frozenMapping?: boolean
  /** `agent_changed` for a coding step: why its approved settings and its admission or approval don't match (7.7b §12a). */
  policy?: string
}

/**
 * The common admission rules (7.7b §6), in the order the cause table lists them: the one function `beginSend` and the
 * release decision both ask, so a rule can't be changed in one and forgotten in the other. Phase guards (what state
 * the attempt must be in) are the callers' own. A pure read.
 */
export function admissionDenial(
  sqlite: DatabaseSync,
  fence: { executionFrozenIn(sqlite: DatabaseSync): unknown },
  o: OrchRow,
  attempt: AttemptRow,
  nowIso: string,
): AdmissionDenial | undefined {
  if (attempt.retired) return { cause: 'retired' }
  if (attempt.stop_requested_at !== null) return { cause: 'owed_stop' }
  if (isTerminalStatus(o.status)) return { cause: 'cancel' }
  if (o.status === 'stopping' || o.status === 'finishing') return { cause: 'stop' }
  const withdrawn = inputWithdrawn(sqlite, o.id, attempt)
  if (withdrawn) return { cause: 'inputs_withdrawn', withdrawn }
  if (o.deadline_at !== null && nowIso >= o.deadline_at) return { cause: 'deadline' }
  if (o.status === 'paused' || o.manual_paused_at !== null) return { cause: 'paused' }
  if (fence.executionFrozenIn(sqlite) !== null) return { cause: 'frozen' }
  if (isFenced(sqlite)) return { cause: 'fenced' }
  if (teamPausedAt(sqlite) !== null || agentPausedAt(sqlite, attempt.agent_id) !== null)
    return { cause: 'hold' }
  const attempts = attemptsOf(sqlite, o.id)
  if (unknownFenceAttempts(o, attempts).length > 0 || cancelFenceAttempts(o, attempts).length > 0)
    return { cause: 'fenced' }
  if (!agentAdmits(sqlite, attempt.agent_id)) return { cause: 'hold' }
  const incarnation = lifecycleOf(sqlite, attempt.agent_id)?.incarnation_id ?? 'untracked'
  if (incarnation !== attempt.agent_incarnation) return { cause: 'agent_changed' }
  const frozen = frozenIncarnation(sqlite, o.id, attempt.agent_id)
  if (frozen !== undefined && frozen !== attempt.agent_incarnation)
    return { cause: 'agent_changed', frozenMapping: true }
  // A coding step runs only under the policy it was approved with: its stored policy, its admission and its current gate
  // must name the same id (DB-only; the CLI's own files are checked by the release check).
  if (attempt.kind === 'step' && attempt.runtime !== 'hermes' && attempt.step_id !== null) {
    const problem = policyBindingProblem(
      sqlite,
      o.id,
      attempt.step_id,
      attempt.agent_id,
      attempt.policy_id,
    )
    if (problem) return { cause: 'agent_changed', policy: problem }
  }
  const view = budgetView(sqlite, o)
  if (overBudget(view)) return { cause: 'budget' }
  if (unknownCostBlocks(sqlite, o, view)) return { cause: 'unknown_cost' }
  return undefined
}
