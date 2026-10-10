import type { DatabaseSync } from 'node:sqlite'
import { ORCH_LIMITS } from '@score/contract'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import {
  addCause,
  addHistory,
  attemptsOf,
  isFinalStep,
  stepsOf,
  type AttemptRow,
  type OrchRow,
  type StepRow,
} from './store.ts'

// Small state transitions shared by the executor, the commands and the human decisions. Each takes the transaction's
// connection and writes only; callers decide when to commit and what to emit.

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/** Room for ordinary text in a run: its reserve minus the protected part kept for Stop and obligation records. */
export const storageRoom = (o: Pick<OrchRow, 'reserve_bytes' | 'stored_bytes'>): number =>
  o.reserve_bytes - ORCH_LIMITS.controlReserveBytes - o.stored_bytes

export function addStored(sqlite: DatabaseSync, orchId: string, bytes: number): void {
  sqlite
    .prepare('UPDATE orchestrations SET stored_bytes = stored_bytes + ? WHERE id = ?')
    .run(bytes, orchId)
}

/** The reserve a run takes at creation: steps and lead turns at 64 KiB each plus the control reserve. */
export const reserveFor = (maxSteps: number, maxLeadTurns: number): number =>
  (maxSteps + maxLeadTurns) * (ORCH_LIMITS.storagePerItemBytes + ORCH_LIMITS.recordsPerItemBytes) +
  ORCH_LIMITS.controlReserveBytes

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
    .prepare("UPDATE message_runs SET state = 'failed' WHERE turn_id = ? AND state = 'pending'")
    .run(attempt.turn_id)
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
    const next = steps.find(
      (step) =>
        (step.status === 'queued' || step.status === 'pending_gate') &&
        step.after_steps.some((id) => {
          const dependency = byId.get(id)
          return (
            dependency !== undefined &&
            isFinalStep(dependency.status) &&
            dependency.status !== 'succeeded'
          )
        }),
    )
    if (!next) return blocked
    const culprit = next.after_steps.find((id) => {
      const dependency = byId.get(id)
      return (
        dependency !== undefined &&
        isFinalStep(dependency.status) &&
        dependency.status !== 'succeeded'
      )
    })!
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

export interface ActiveCounts {
  perAgent: Map<string, number>
  perRun: Map<string, number>
  total: number
}

/** Step attempts that hold capacity: not yet terminal, not abandoned (abandonment releases capacity). */
export function activeStepCounts(sqlite: DatabaseSync): ActiveCounts {
  const rows = sqlite
    .prepare(
      `SELECT orchestration_id AS orch, agent_id AS agent, COUNT(*) AS n FROM orc_attempts
       WHERE kind = 'step' AND state IN ('created', 'send_started', 'running', 'unknown') AND abandoned_at IS NULL
       GROUP BY orchestration_id, agent_id`,
    )
    .all() as { orch: string; agent: string; n: number }[]
  const counts: ActiveCounts = { perAgent: new Map(), perRun: new Map(), total: 0 }
  for (const row of rows) {
    counts.perAgent.set(row.agent, (counts.perAgent.get(row.agent) ?? 0) + row.n)
    counts.perRun.set(row.orch, (counts.perRun.get(row.orch) ?? 0) + row.n)
    counts.total += row.n
  }
  return counts
}

export const liveAttempts = (sqlite: DatabaseSync, orchId: string): AttemptRow[] =>
  attemptsOf(sqlite, orchId).filter((attempt) =>
    ['created', 'send_started', 'running'].includes(attempt.state),
  )

/**
 * v8.1 item 2: every change that can make waiting work admissible (limits raised, Resume, fence lift, waiver, capacity
 * or quota released, an agent ready again) increments the global admission revision in its own transaction. Runs
 * remember the revision they last evaluated, so a restart between the change and the pass loses nothing.
 */
export function bumpAdmission(sqlite: DatabaseSync): void {
  sqlite
    .prepare('UPDATE orc_global SET admission_revision = admission_revision + 1 WHERE id = 1')
    .run()
}
export const admissionRevision = (sqlite: DatabaseSync): number =>
  (
    sqlite.prepare('SELECT admission_revision AS r FROM orc_global WHERE id = 1').get() as {
      r: number
    }
  ).r

/**
 * Finish request: an admission barrier in one transaction. No further admission, queued work retired with a
 * disposition, open gates and inquiries withdrawn, further commands sealed; admitted attempts drain. Shared by the
 * lead's `orch.finish` and the workflow planner (attemptId null).
 */
export function beginFinish(
  ctx: Ctx,
  o: OrchRow,
  attemptId: string | null,
  outcome: 'success' | 'partial' | 'failed',
  summary: string,
): string[] {
  const { sqlite, now } = ctx
  sqlite
    .prepare(
      `UPDATE orchestrations SET status = 'finishing', pause_reason = NULL, finish_requested_at = ?, finish_attempt_id = ?, finish_outcome = ?, finish_summary = ? WHERE id = ?`,
    )
    .run(now, attemptId, outcome, summary, o.id)
  const retired = retireQueued(sqlite, o.id, 'not_started: run_finishing', now)
  withdrawGates(sqlite, o.id, now)
  withdrawInquiries(sqlite, o.id, now)
  for (const created of attemptsOf(sqlite, o.id).filter((a) => a.state === 'created')) {
    refuseAttempt(sqlite, created, 'not dispatched: run finishing', now)
    if (created.step_id)
      setStepStatus(sqlite, o.id, created.step_id, 'not_started', 'not_started: run_finishing', now)
  }
  addStored(sqlite, o.id, utf8Bytes(summary))
  addHistory(sqlite, o.id, 'finish_requested', { outcome, attemptId, retired }, now)
  journalSoft(ctx, () =>
    ctx.journal.append({ kind: 'transition', orchestrationId: o.id, what: 'finish' }),
  )
  touch(ctx, o.id)
  return retired
}

const CONTROL_KINDS = ['paused', 'resumed', 'limits_changed']

/**
 * v8.1 item 5: control history is bounded (200 records per run). Older pause / resume / limits records fold into one
 * counter row; the journaled transitions (finish, waiver, abandon, ...) are different kinds and are never compacted.
 */
export function compactControlHistory(sqlite: DatabaseSync, orchId: string, limit = 200): void {
  const marks = CONTROL_KINDS.map(() => '?').join(',')
  const count = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM orc_history WHERE orchestration_id = ? AND kind IN (${marks})`,
      )
      .get(orchId, ...CONTROL_KINDS) as { n: number }
  ).n
  if (count <= limit) return
  const extra = count - limit
  sqlite
    .prepare(
      `DELETE FROM orc_history WHERE id IN (SELECT id FROM orc_history WHERE orchestration_id = ? AND kind IN (${marks}) ORDER BY id LIMIT ?)`,
    )
    .run(orchId, ...CONTROL_KINDS, extra)
  const row = sqlite
    .prepare(
      "SELECT id, detail FROM orc_history WHERE orchestration_id = ? AND kind = 'compacted_control'",
    )
    .get(orchId) as { id: number; detail: string } | undefined
  if (row)
    sqlite
      .prepare('UPDATE orc_history SET detail = ? WHERE id = ?')
      .run(
        JSON.stringify({ count: (JSON.parse(row.detail) as { count: number }).count + extra }),
        row.id,
      )
  else
    sqlite
      .prepare(
        "INSERT INTO orc_history (orchestration_id, kind, detail, at) VALUES (?, 'compacted_control', ?, ?)",
      )
      .run(orchId, JSON.stringify({ count: extra }), new Date().toISOString())
}
