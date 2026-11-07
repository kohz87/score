import type { DatabaseSync } from 'node:sqlite'
import {
  addCause,
  attemptsOf,
  isFinalStep,
  stepsOf,
  type AttemptRow,
  type StepRow,
} from './store.ts'

export function setStepStatus(
  sqlite: DatabaseSync,
  orchId: string,
  stepId: string,
  status: StepRow['status'],
  disposition: string | null,
  now: string,
): void {
  sqlite
    .prepare(
      'UPDATE orc_steps SET status = ?, disposition = ?, updated_at = ? WHERE orchestration_id = ? AND id = ?',
    )
    .run(status, disposition, now, orchId, stepId)
}

/** The attempt never reached Hermes (no `send_started`): its reply row is closed and its reservation released. */
export function refuseAttempt(
  sqlite: DatabaseSync,
  attempt: AttemptRow,
  reason: string,
  now: string,
): void {
  sqlite
    .prepare(
      "UPDATE orc_attempts SET state = 'refused', unknown_reason = ?, terminated_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(reason, now, now, attempt.id)
  sqlite
    .prepare(
      "UPDATE message_runs SET state = 'failed' WHERE (turn_id = ? OR orchestration_attempt_id = ?) AND state = 'pending'",
    )
    .run(attempt.turn_id, attempt.id)
}

/** Retires the attempt and owes Hermes a Stop (retried by the executor until acknowledged). */
export function oweStop(sqlite: DatabaseSync, attempt: AttemptRow, now: string): void {
  sqlite
    .prepare(
      `UPDATE orc_attempts SET retired = 1, stop_requested_at = COALESCE(stop_requested_at, ?), updated_at = ? WHERE id = ?`,
    )
    .run(now, now, attempt.id)
}

export function withdrawGates(
  sqlite: DatabaseSync,
  orchId: string,
  now: string,
  stepId?: string,
): void {
  sqlite
    .prepare(
      `UPDATE orc_gates SET status = 'withdrawn', revision = revision + 1, decided_at = ?
       WHERE orchestration_id = ? AND status = 'open' ${stepId ? 'AND step_id = ?' : ''}`,
    )
    .run(...(stepId ? [now, orchId, stepId] : [now, orchId]))
}

export function withdrawInquiries(sqlite: DatabaseSync, orchId: string, now: string): void {
  sqlite
    .prepare(
      `UPDATE orc_inquiries SET status = 'withdrawn', revision = revision + 1, answered_at = ?
       WHERE orchestration_id = ? AND status = 'open'`,
    )
    .run(now, orchId)
}

/** Queued work that will never start (Stop, finish): permanently retired with a recorded disposition. */
export function retireQueued(
  sqlite: DatabaseSync,
  orchId: string,
  disposition: string,
  now: string,
): string[] {
  const retired: string[] = []
  for (const step of stepsOf(sqlite, orchId))
    if (step.status === 'pending_gate' || step.status === 'queued') {
      setStepStatus(sqlite, orchId, step.id, 'not_started', disposition, now)
      sqlite
        .prepare('UPDATE orc_steps SET retired = 1 WHERE orchestration_id = ? AND id = ?')
        .run(orchId, step.id)
      retired.push(step.id)
    }
  return retired
}

/**
 * A failed, cancelled, rejected or blocked step blocks every waiting step that depends on it, transitively, and wakes
 * the lead once per blocked step. Returns the ids blocked.
 */
export function cascadeBlocked(sqlite: DatabaseSync, orchId: string, now: string): string[] {
  const blocked: string[] = []
  for (;;) {
    const steps = stepsOf(sqlite, orchId)
    const byId = new Map(steps.map((step) => [step.id, step]))
    // A coding step blocked "agent changed" or "limit reached" keeps its suspended attempt and may go on once the person
    // decides (7.7b §12a): the steps waiting for it keep waiting instead of being blocked for good.
    const suspended = new Set(
      attemptsOf(sqlite, orchId)
        .filter((attempt) => attempt.suspended && attempt.step_id !== null)
        .map((attempt) => attempt.step_id),
    )
    const failedDependency = (id: string): boolean => {
      const dependency = byId.get(id)
      return (
        dependency !== undefined &&
        isFinalStep(dependency.status) &&
        dependency.status !== 'succeeded' &&
        !(dependency.status === 'blocked' && suspended.has(dependency.id))
      )
    }
    const next = steps.find(
      (step) =>
        (step.status === 'queued' || step.status === 'pending_gate') &&
        step.after_steps.some(failedDependency),
    )
    if (!next) return blocked
    const culprit = next.after_steps.find(failedDependency)!
    setStepStatus(
      sqlite,
      orchId,
      next.id,
      'blocked',
      `dependency ${culprit} is ${byId.get(culprit)!.status}`,
      now,
    )
    withdrawGates(sqlite, orchId, now, next.id)
    addCause(sqlite, orchId, 'step_blocked', next.id, now, `after ${culprit}`)
    blocked.push(next.id)
  }
}
