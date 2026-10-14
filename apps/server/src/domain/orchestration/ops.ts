import type { DatabaseSync } from 'node:sqlite'
import { ORCH_LIMITS, WORKFLOW_LIMITS } from '@score/contract'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import {
  addCause,
  addHistory,
  attemptsOf,
  isFinalStep,
  readStep,
  stepsOf,
  type AttemptRow,
  type OrchRow,
  type StepRow,
} from './store.ts'

// Small state transitions shared by the executor, the commands and the human decisions. Each takes the transaction's
// connection and writes only; callers decide when to commit and what to emit.

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/**
 * Room for ordinary text and observations in a run: its reserve minus the protected part kept for Stop and obligation
 * records, minus the part held for coding inventory (unless coding inventory already spilled past its own part, in which
 * case the spill is counted as ordinary use).
 */
export const storageRoom = (
  o: Pick<
    OrchRow,
    'reserve_bytes' | 'stored_bytes' | 'coding_reserve_bytes' | 'coding_stored_bytes'
  >,
): number =>
  o.reserve_bytes -
  ORCH_LIMITS.controlReserveBytes -
  o.coding_reserve_bytes -
  (o.stored_bytes - Math.min(o.coding_stored_bytes, o.coding_reserve_bytes))

export function addStored(sqlite: DatabaseSync, orchId: string, bytes: number): void {
  sqlite
    .prepare('UPDATE orchestrations SET stored_bytes = stored_bytes + ? WHERE id = ?')
    .run(bytes, orchId)
}

/** Coding inventory (a coding step's result, retained input and run result): charged to the coding part of the reserve. */
export function addCodingStored(sqlite: DatabaseSync, orchId: string, bytes: number): void {
  sqlite
    .prepare(
      'UPDATE orchestrations SET stored_bytes = stored_bytes + ?, coding_stored_bytes = coding_stored_bytes + ? WHERE id = ?',
    )
    .run(bytes, bytes, orchId)
}

/** The reserve a run takes at creation: steps and lead turns at 64 KiB each plus the control reserve. */
export const reserveFor = (maxSteps: number, maxLeadTurns: number, codingItems = 0): number =>
  (maxSteps + maxLeadTurns) * (ORCH_LIMITS.storagePerItemBytes + ORCH_LIMITS.recordsPerItemBytes) +
  ORCH_LIMITS.controlReserveBytes +
  codingItems * CODING_ITEM_EXTRA_BYTES

/** One kept copy of a coding result (the translator's cap), and the run output kept beside it. */
export const CODING_RESULT_BYTES = 32 * 1024
export const CODING_OUTPUT_BYTES = 8 * 1024
/** A step result is the kept reply plus a short cut notice, bounded at this much. */
const CODING_RESULT_COPY_BYTES = CODING_RESULT_BYTES + 128

/**
 * What a coding worker item reserves beyond an ordinary step (design §11, F2 #4): everything one item can retain, so
 * inventory never reaches the control reserve. One retained input (the step input cap), the step result and the attempt
 * result (two copies), the retained reply (`coding_run_results`), the run output, and 2 KiB for each of up to 20
 * dispatch generations. Independent of the observation pool, so terminal state, proof, refusal receipt and Stop always fit.
 */
export const CODING_ITEM_EXTRA_BYTES =
  ORCH_LIMITS.stepInputBytes +
  2 * CODING_RESULT_COPY_BYTES +
  CODING_RESULT_BYTES +
  CODING_OUTPUT_BYTES +
  20 * 2 * 1024

/**
 * What one coding item of a WORKFLOW reserves (7.7c §5): everything an orchestration's item keeps, plus the two copies a
 * workflow adds (the `wf_results` output and the node's own output, 32 KiB each), the verdict record (2 KiB) and the
 * generation records of the renewals the person may ask for (each renewal is a fresh attempt with up to 20 generations).
 * Computed from the constants, so the partition can never drift from what is written into it.
 */
export const WORKFLOW_CODING_ITEM_BYTES =
  CODING_ITEM_EXTRA_BYTES +
  2 * WORKFLOW_LIMITS.outputBytes +
  2 * 1024 +
  WORKFLOW_LIMITS.maxRenewalsPerNode * 20 * 2 * 1024

/** The coding item size of a run, by its planner: a workflow's items hold more than an orchestration's. */
export const codingItemBytesOf = (planner: 'lead' | 'workflow'): number =>
  planner === 'workflow' ? WORKFLOW_CODING_ITEM_BYTES : CODING_ITEM_EXTRA_BYTES

/** A run can release at most `codingSteps` launches, and each coding item needs one, so that bounds the items. */
export const codingItemsFor = (maxSteps: number, codingSteps: number): number =>
  Math.min(maxSteps, codingSteps)

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
         AND suspended = 0
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
  attemptsOf(sqlite, orchId).filter(
    (attempt) =>
      !attempt.suspended && ['created', 'send_started', 'running'].includes(attempt.state),
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
    // A step that is already final (a coding worker's blocked step waiting with its suspended attempt) keeps its own
    // status and reason; only waiting work becomes "not started".
    const step = created.step_id ? readStep(sqlite, o.id, created.step_id) : undefined
    if (created.step_id && (!step || !isFinalStep(step.status)))
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

/**
 * Observed tool and thinking rows of an orchestration attempt's run are retained with the run, so they are charged to its
 * allowance at the writer (v8.1 item 5). Returns false when the run has no room left (the protected reserve for Stop and
 * obligation evidence is never spent here): the writer then drops the row. Runs outside any orchestration are unbounded.
 */
export function chargeObservation(sqlite: DatabaseSync, runId: string, bytes: number): boolean {
  const owner = sqlite
    .prepare(
      `SELECT o.id AS id, o.reserve_bytes AS reserve_bytes, o.stored_bytes AS stored_bytes,
              o.coding_reserve_bytes AS coding_reserve_bytes, o.coding_stored_bytes AS coding_stored_bytes FROM message_runs m
       JOIN orc_attempts a ON a.id = m.orchestration_attempt_id JOIN orchestrations o ON o.id = a.orchestration_id
       WHERE m.run_id = ?`,
    )
    .get(runId) as
    | {
        id: string
        reserve_bytes: number
        stored_bytes: number
        coding_reserve_bytes: number
        coding_stored_bytes: number
      }
    | undefined
  if (!owner) return true
  if (bytes > storageRoom(owner)) return false
  addStored(sqlite, owner.id, bytes)
  return true
}

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
