import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getCodingAgent } from '../../runtimes/coding/store.ts'
import { foldCodingLaunches } from './coding-records.ts'
import type { ExecutionJournal } from './journal.ts'
import { setStepStatus } from './ops.ts'
import { addCause, type AttemptRow, type OrchRow } from './store.ts'

// Coding workers in the executor (7.7b): generation identities, the typed release causes and what each does to the
// attempt and its step (design §5, §6). Plain functions over the transaction's connection; the executor owns the policy
// of when to call them.

/** A coding attempt is bounded: past this many dispatch generations the step is blocked for the person (no loop). */
export const MAX_GENERATIONS = 20

export type CauseClass = 'hold' | 'terminal' | 'agent_changed' | 'limit' | 'refusal'

const HOLD = new Set([
  'paused',
  'frozen',
  'hold',
  'fenced',
  'restart',
  'budget',
  'unknown_cost',
  'deadline_changed',
])
const TERMINAL = new Set(['stop', 'cancel', 'retired', 'owed_stop', 'inputs_withdrawn', 'deadline'])

/**
 * The cause table (design §6). Readiness causes and anything not listed are refusals: they count toward 7.1's streak and
 * lifetime limit, so an unknown cause can never loop (it is bounded like any refusal).
 */
export function causeClass(cause: string): CauseClass {
  if (HOLD.has(cause)) return 'hold'
  if (TERMINAL.has(cause)) return 'terminal'
  if (cause === 'agent_changed') return 'agent_changed'
  if (cause === 'limit') return 'limit'
  return 'refusal'
}

export interface GenerationRow {
  attempt_id: string
  generation: number
  turn_id: string
  launch_id: string
  message_id: string
  run_id: string | null
  closed_cause: string | null
  closed_at: string | null
  created_at: string
}

export const codingTurnId = (attemptTurnId: string, generation: number): string =>
  `${attemptTurnId}:g${generation}`

/** The runtime of an agent as the coding runtime knows it; `hermes` for any agent that is not a coding agent. */
export function runtimeOfAgent(sqlite: DatabaseSync, agentId: string): string {
  return getCodingAgent(sqlite, agentId, true)?.runtime ?? 'hermes'
}

export function readGeneration(
  sqlite: DatabaseSync,
  attemptId: string,
  generation: number,
): GenerationRow | undefined {
  return sqlite
    .prepare('SELECT * FROM orc_generations WHERE attempt_id = ? AND generation = ?')
    .get(attemptId, generation) as GenerationRow | undefined
}

export function generationsOf(sqlite: DatabaseSync, attemptId: string): GenerationRow[] {
  return sqlite
    .prepare('SELECT * FROM orc_generations WHERE attempt_id = ? ORDER BY generation')
    .all(attemptId) as unknown as GenerationRow[]
}

/**
 * What the coding journal (authoritative) says about a launch, for deciding whether a generation provably launched
 * nothing. The database's projection row is the cheap answer; the journal is read when the row is missing, because a
 * projection that failed or a restored database may lack it.
 */
export type LaunchFacts =
  | { kind: 'none' }
  | {
      kind: 'known'
      phase: string
      revoked: boolean
      mayHaveExecuted: boolean
      /** Ended proof was recorded (phase `ended` or `settled` with a proof, and not merely waived). */
      proof: boolean
      revokeCause: string | null
    }

export function launchFacts(
  sqlite: DatabaseSync,
  journal: Pick<ExecutionJournal, 'readOwn'>,
  launchId: string,
): LaunchFacts | { kind: 'unreadable' } {
  const row = sqlite
    .prepare(
      'SELECT phase, revoked, may_have_executed, proof, revoke_cause, waiver FROM coding_launches WHERE launch_id = ?',
    )
    .get(launchId) as
    | {
        phase: string
        revoked: number
        may_have_executed: number
        proof: string | null
        revoke_cause: string | null
        waiver: number
      }
    | undefined
  if (row)
    return {
      kind: 'known',
      phase: row.phase,
      revoked: row.revoked === 1,
      mayHaveExecuted: row.may_have_executed === 1,
      proof:
        (row.phase === 'ended' || row.phase === 'settled') &&
        row.proof !== null &&
        row.waiver === 0,
      revokeCause: row.revoke_cause,
    }
  const read = journal.readOwn()
  if (!read.ok) return { kind: 'unreadable' }
  const launch = foldCodingLaunches(read.entries).get(launchId)
  if (!launch) return { kind: 'none' }
  const s = launch.state
  return {
    kind: 'known',
    phase: s.phase,
    revoked: s.revoked,
    mayHaveExecuted: s.mayHaveExecuted,
    proof: (s.phase === 'ended' || s.phase === 'settled') && s.proof !== undefined && !s.waiver,
    revokeCause: s.revokeCause ?? null,
  }
}

/** Nothing of this launch ever ran: it was never requested, or it was revoked before `releasing` (design §6). */
export const provenNoLaunch = (facts: LaunchFacts | { kind: 'unreadable' }): boolean =>
  facts.kind === 'none' || (facts.kind === 'known' && facts.revoked && !facts.mayHaveExecuted)

/** The reply row of a generation that never launched is closed (an already attached reply ends with its run). */
function failPendingReply(sqlite: DatabaseSync, attemptId: string, generation: number): void {
  sqlite
    .prepare(
      "UPDATE message_runs SET state = 'failed' WHERE orchestration_attempt_id = ? AND generation = ? AND state = 'pending'",
    )
    .run(attemptId, generation)
}

/**
 * Applies a proven no-launch closure of generation `generation` for a cause that is not a refusal (design §6 table):
 * the generation row is closed, the attempt and its step move as the cause says, nothing touches the refusal counters,
 * and a proven no-launch has known-zero execution spend. Idempotent: it only acts while the attempt is still at that
 * generation in `send_started` or `running`.
 */
/**
 * A generation that provably launched nothing keeps only the hash of its input (design §11): it was never sent, so
 * nothing needs the text again for recovery, and only the current generation and launched generations keep theirs.
 */
export function dropUnlaunchedInput(
  sqlite: DatabaseSync,
  attemptId: string,
  generation: number,
): void {
  const rows = sqlite
    .prepare(
      `SELECT id, payload FROM command_intents WHERE orchestration_attempt_id = ? AND generation = ?`,
    )
    .all(attemptId, generation) as { id: string; payload: string }[]
  for (const row of rows) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof payload['input'] !== 'string' || payload['inputSha256'] !== undefined) continue
    payload['inputSha256'] = createHash('sha256').update(payload['input']).digest('hex')
    payload['input'] = ''
    sqlite
      .prepare('UPDATE command_intents SET payload = ? WHERE id = ?')
      .run(JSON.stringify(payload), row.id)
  }
}

export function applyClosure(
  sqlite: DatabaseSync,
  o: Pick<OrchRow, 'id'>,
  attempt: Pick<AttemptRow, 'id' | 'step_id' | 'dispatch_generation'> & { state: string },
  generation: number,
  cause: string,
  now: string,
): void {
  sqlite
    .prepare(
      'UPDATE orc_generations SET closed_cause = COALESCE(closed_cause, ?), closed_at = COALESCE(closed_at, ?) WHERE attempt_id = ? AND generation = ?',
    )
    .run(cause, now, attempt.id, generation)
  failPendingReply(sqlite, attempt.id, generation)
  dropUnlaunchedInput(sqlite, attempt.id, generation)
  if (
    attempt.dispatch_generation !== generation ||
    !['send_started', 'running'].includes(attempt.state)
  )
    return
  const klass = causeClass(cause)
  if (klass === 'terminal') {
    sqlite
      .prepare(
        `UPDATE orc_attempts SET state = 'terminated', run_id = NULL, terminated_at = ?, unknown_reason = NULL,
           spend_usd = 0, spend_complete = 1, settled = 1, reserved_usd = 0, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, attempt.id)
    if (attempt.step_id) {
      const step = sqlite
        .prepare('SELECT status FROM orc_steps WHERE orchestration_id = ? AND id = ?')
        .get(o.id, attempt.step_id) as { status: string } | undefined
      if (step && ['admitted', 'unknown'].includes(step.status)) {
        setStepStatus(sqlite, o.id, attempt.step_id, 'cancelled', cause, now)
        addCause(sqlite, o.id, 'step_cancelled', attempt.step_id, now, cause)
      }
    }
    return
  }
  const suspended = klass === 'agent_changed' || klass === 'limit'
  sqlite
    .prepare(
      "UPDATE orc_attempts SET state = 'created', run_id = NULL, suspended = ?, updated_at = ? WHERE id = ?",
    )
    .run(suspended ? 1 : 0, now, attempt.id)
  if (suspended && attempt.step_id) {
    const disposition = klass === 'limit' ? 'coding_limit' : 'agent_changed'
    setStepStatus(sqlite, o.id, attempt.step_id, 'blocked', disposition, now)
    addCause(sqlite, o.id, 'step_blocked', attempt.step_id, now, disposition)
  }
}
