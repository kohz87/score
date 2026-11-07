import type { DatabaseSync } from 'node:sqlite'
import { WORKFLOW_LIMITS } from '@score/contract'
import { bumpAdmission } from './ops-admission.ts'
import { setStepStatus } from './ops-steps.ts'
import { addCause, type AttemptRow } from './store.ts'

/**
 * The one transition for a proven refusal of a step attempt's dispatch generation (v8.2 / v8.3), used by the live path
 * and by restore reconciliation: counters, the five-in-a-row ten-minute wait and the lifetime limit (a workflow node
 * then needs the person; an orchestration step fails for the lead). Returns what happened.
 */
export function recordRefusal(
  sqlite: DatabaseSync,
  o: { id: string; planner: 'lead' | 'workflow' },
  attempt: Pick<
    AttemptRow,
    'id' | 'turn_id' | 'step_id' | 'refused_total' | 'refused_streak' | 'runtime'
  >,
  generation: number,
  now: string,
): 'retry' | 'wait' | 'needs_person' | 'failed' {
  const total = attempt.refused_total + 1
  const streak = attempt.refused_streak + 1
  const lifetime = total >= WORKFLOW_LIMITS.refusedLifetime
  if (lifetime && o.planner === 'lead') {
    // The lead decides what to do with a step Hermes keeps refusing.
    sqlite
      .prepare(
        "UPDATE orc_attempts SET state = 'refused', unknown_reason = 'hermes_refused', refused_total = ?, refused_streak = ?, refused_generation = ?, terminated_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(total, streak, generation, now, now, attempt.id)
    sqlite
      .prepare(
        "UPDATE message_runs SET state = 'failed' WHERE (turn_id = ? OR orchestration_attempt_id = ?) AND state = 'pending'",
      )
      .run(attempt.turn_id, attempt.id)
    if (attempt.step_id) {
      setStepStatus(sqlite, o.id, attempt.step_id, 'failed', 'hermes_refused', now)
      addCause(
        sqlite,
        o.id,
        'step_failed',
        attempt.step_id,
        now,
        'Hermes refused this step 20 times',
      )
    }
    bumpAdmission(sqlite)
    return 'failed'
  }
  if (lifetime && o.planner === 'workflow' && attempt.runtime !== 'hermes' && attempt.step_id) {
    // A coding node refused 20 times waits for the person exactly like one held back 20 times (7.7c §4, F1 #4): the one
    // attempt is suspended, the node keeps its step, and Try again renews it under the same bound (past it the node fails
    // and gives up its slot and reservation). It is never left `needs_person` outside that hold.
    sqlite
      .prepare(
        "UPDATE orc_attempts SET state = 'created', refused_total = ?, refused_streak = ?, refused_generation = ?, needs_person = 0, suspended = 1, next_try_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(total, streak, generation, now, attempt.id)
    setStepStatus(sqlite, o.id, attempt.step_id, 'blocked', 'held_back', now)
    return 'needs_person'
  }
  const wait = streak >= WORKFLOW_LIMITS.refusedPause && !lifetime
  sqlite
    .prepare(
      "UPDATE orc_attempts SET state = 'created', refused_total = ?, refused_streak = ?, refused_generation = ?, needs_person = ?, next_try_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      total,
      streak,
      generation,
      lifetime ? 1 : 0,
      wait
        ? new Date(Date.parse(now) + WORKFLOW_LIMITS.refusedRetryMinutes * 60_000).toISOString()
        : null,
      now,
      attempt.id,
    )
  return lifetime ? 'needs_person' : wait ? 'wait' : 'retry'
}
