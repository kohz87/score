import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import {
  foldCodingLaunches,
  maxCodingN,
  type CodingLaunch,
  type CodingState,
} from './coding-records.ts'
import type { Projection } from './coding-journal.ts'
import type { JournalEntry } from './journal.ts'
import type { Mismatch } from './fence.ts'

// The database side of the coding-run journal (7.7a design v7 §2, §3): the per-launch projection, the checkpoint
// sequence and the reconciliation that rebuilds what a restored or crashed database lacks. The journal is authoritative.

// The authority-relevant projection of a launch: everything the journal's record carries, so reconciliation compares
// full state and not just the sequence number (an equal number with a different phase or revocation is a divergence).
const RowSchema = z.object({
  launch_id: z.string(),
  run_id: z.string(),
  turn_id: z.string(),
  generation: z.int(),
  phase: z.string(),
  revoked: z.int(),
  may_have_executed: z.int(),
  unit: z.string().nullable(),
  invocation_id: z.string().nullable(),
  cgroup: z.string().nullable(),
  proof: z.string().nullable(),
  disposition: z.string().nullable(),
  waiver: z.int(),
  stop_cause: z.string().nullable(),
  inherited: z.int(),
  journal_n: z.int(),
  unsendable: z.int(),
})
type Row = z.infer<typeof RowSchema>

const ROW_COLUMNS =
  'launch_id, run_id, turn_id, generation, phase, revoked, may_have_executed, unit, invocation_id, cgroup, proof, disposition, waiver, stop_cause, inherited, journal_n, unsendable'

/** The fields in which a row differs from the journal's state for the same record number (empty = they agree). */
function divergence(row: Row, state: CodingState): string[] {
  const differs: string[] = []
  const check = (name: string, mine: unknown, theirs: unknown) => {
    if (mine !== theirs) differs.push(name)
  }
  check('run', row.run_id, state.runId)
  check('turn', row.turn_id, state.turnId)
  check('generation', row.generation, state.generation)
  check('phase', row.phase, state.phase)
  check('revoked', row.revoked, state.revoked ? 1 : 0)
  check('release possibility', row.may_have_executed, state.mayHaveExecuted ? 1 : 0)
  check('unit', row.unit, state.unit ?? null)
  check('invocation', row.invocation_id, state.invocationId ?? null)
  check('cgroup', row.cgroup, state.cgroup ?? null)
  check('proof', row.proof, state.proof ?? null)
  check('disposition', row.disposition, state.disposition ?? null)
  check('waiver', row.waiver, state.waiver ? 1 : 0)
  // The journal's first stop cause is the truth; a row with a cause the journal never saw is not a divergence.
  if (state.stopCause !== undefined) check('stop cause', row.stop_cause, state.stopCause)
  check('inherited', row.inherited, state.inherited ? 1 : 0)
  if (isUnsendable(state) && row.unsendable === 0) differs.push('unsendable')
  return differs
}

/** A launch that was released, revoked or ended can never be sent again, whatever happens to any fence. */
export function isUnsendable(state: CodingState): boolean {
  return (
    state.mayHaveExecuted ||
    state.revoked ||
    state.inherited === true ||
    state.phase === 'ended' ||
    state.phase === 'settled'
  )
}

function upsertLaunch(sqlite: DatabaseSync, launch: CodingLaunch, now: string): void {
  const s = launch.state
  sqlite
    .prepare(
      `INSERT INTO coding_launches (launch_id, run_id, turn_id, generation, phase, revoked, may_have_executed, unit,
         invocation_id, cgroup, proof, disposition, waiver, stop_cause, inherited, journal_n, unsendable, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (launch_id) DO UPDATE SET run_id = excluded.run_id, turn_id = excluded.turn_id,
         generation = excluded.generation, phase = excluded.phase, revoked = excluded.revoked,
         stop_cause = COALESCE(excluded.stop_cause, coding_launches.stop_cause),
         inherited = MAX(coding_launches.inherited, excluded.inherited),
         may_have_executed = excluded.may_have_executed, unit = excluded.unit, invocation_id = excluded.invocation_id,
         cgroup = excluded.cgroup, proof = excluded.proof, disposition = excluded.disposition, waiver = excluded.waiver,
         journal_n = excluded.journal_n, unsendable = MAX(coding_launches.unsendable, excluded.unsendable),
         updated_at = excluded.updated_at
       WHERE excluded.journal_n > coding_launches.journal_n`,
    )
    .run(
      s.launchId,
      s.runId,
      s.turnId,
      s.generation,
      s.phase,
      s.revoked ? 1 : 0,
      s.mayHaveExecuted ? 1 : 0,
      s.unit ?? null,
      s.invocationId ?? null,
      s.cgroup ?? null,
      s.proof ?? null,
      s.disposition ?? null,
      s.waiver ? 1 : 0,
      s.stopCause ?? null,
      s.inherited ? 1 : 0,
      launch.n,
      isUnsendable(s) ? 1 : 0,
      now,
    )
}

function repairLaunch(sqlite: DatabaseSync, launch: CodingLaunch, now: string): void {
  const s = launch.state
  sqlite
    .prepare(
      `UPDATE coding_launches SET run_id = ?, turn_id = ?, generation = ?, phase = ?,
         revoked = MAX(revoked, ?), may_have_executed = MAX(may_have_executed, ?), unit = ?, invocation_id = ?,
         cgroup = ?, proof = ?, disposition = ?, waiver = ?, stop_cause = COALESCE(?, stop_cause),
         inherited = MAX(inherited, ?), unsendable = MAX(unsendable, ?), updated_at = ?
       WHERE launch_id = ?`,
    )
    .run(
      s.runId,
      s.turnId,
      s.generation,
      s.phase,
      s.revoked ? 1 : 0,
      s.mayHaveExecuted ? 1 : 0,
      s.unit ?? null,
      s.invocationId ?? null,
      s.cgroup ?? null,
      s.proof ?? null,
      s.disposition ?? null,
      s.waiver ? 1 : 0,
      s.stopCause ?? null,
      s.inherited ? 1 : 0,
      isUnsendable(s) ? 1 : 0,
      now,
      s.launchId,
    )
}

const CODING_INTENT_KIND = 'start_coding_run'

/**
 * The turn behind a launch the journal witnessed is never admitted again (a restored database may have lost the accepted
 * intent and run): its start intent is retired as `failed`, which admission refuses, or created that way when the
 * database lost it. An intent that was accepted with its run is left alone: that turn answers with its existing run.
 * Returns the rows changed.
 */
function retireIntent(
  sqlite: DatabaseSync,
  state: CodingState,
  now: string,
  inherited = false,
): number {
  const row = sqlite
    .prepare('SELECT id, state, result FROM command_intents WHERE idempotency_key = ?')
    .get(state.turnId) as { id: string; state: string; result: string | null } | undefined
  const note = inherited
    ? 'This turn belongs to the installation this one was copied from; it is never sent here.'
    : 'The journal witnessed this turn executing; it is never sent again.'
  if (!row)
    return Number(
      sqlite
        .prepare(
          `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, last_error, created_at, updated_at)
           VALUES (?, ?, ?, '{}', 'failed', ?, ?, ?)`,
        )
        .run(`retired-${state.launchId}`, CODING_INTENT_KIND, state.turnId, note, now, now).changes,
    )
  if (row.state === 'failed' || (row.state === 'accepted' && row.result)) return 0
  return Number(
    sqlite
      .prepare(
        `UPDATE command_intents SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(note, now, row.id).changes,
  )
}

/**
 * A launch inherited from another installation is evidence, never ours to act on: whatever the copied database holds of
 * its processes (the process row, member identities, the hold on the agent) is retired, so nothing here ever signals the
 * source's processes, and its turn's start intent is retired whether or not it had been released (the source may still
 * release it later, and the copy must not also send it). Idempotent; returns the rows changed.
 */
function retireInherited(sqlite: DatabaseSync, state: CodingState, now: string): number {
  let changed = retireIntent(sqlite, state, now, true)
  for (const table of ['coding_processes', 'coding_process_members', 'coding_pending_terminals'])
    changed += Number(
      sqlite.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(state.runId).changes,
    )
  changed += Number(
    sqlite
      .prepare('UPDATE coding_launches SET held = 0 WHERE launch_id = ? AND held != 0')
      .run(state.launchId).changes,
  )
  return changed
}

/** What the copy's `inherited-retired` records name (FZ3, decision 69), as sets. */
export interface InheritedRetirements {
  intents: Set<string>
  processes: Set<string>
  attempts: Set<string>
}

export function inheritedRetirements(entries: readonly JournalEntry[]): InheritedRetirements {
  const result: InheritedRetirements = {
    intents: new Set(),
    processes: new Set(),
    attempts: new Set(),
  }
  for (const entry of entries) {
    if (entry.kind !== 'inherited-retired') continue
    for (const id of entry.intents) result.intents.add(id)
    for (const id of entry.processes) result.processes.add(id)
    for (const id of entry.attempts) result.attempts.add(id)
  }
  return result
}

/**
 * Whether this installation owns the process row of `runId` and may signal its group: false when a confirmed copy
 * retired the row (it was inherited from the source installation) or when the journal says the run's launch was
 * inherited. A row with no evidence either way is this installation's own (the process-group engine keeps no journal).
 */
export function ownsProcessRowIn(
  entries: readonly JournalEntry[],
  runId: string,
  /** A confirmed copy must hold its `inherited-retired` record: without it the rows can't be told apart. */
  copied = false,
): boolean {
  if (copied && !entries.some((entry) => entry.kind === 'inherited-retired')) return false
  if (inheritedRetirements(entries).processes.has(runId)) return false
  for (const launch of foldCodingLaunches(entries).values())
    if (launch.state.runId === runId && launch.state.inherited) return false
  return true
}

/**
 * Re-applies every `inherited-retired` record to the database: the copied intents become `failed` (created that way
 * when a restore lost the row), the inherited process rows and their member/terminal rows are deleted, and the
 * orchestration attempts the source had not sent become `unknown` (never sent again). Idempotent; run on every start,
 * every restore and every fence lift, so restoring a copy's own backup can never re-open them. Returns rows changed.
 */
export function applyInheritedRetirements(
  sqlite: DatabaseSync,
  entries: readonly JournalEntry[],
  now: string,
): number {
  const retired = inheritedRetirements(entries)
  let changed = 0
  const note =
    'This turn belongs to the installation this one was copied from; it is never sent here.'
  for (const turnId of retired.intents) {
    const row = sqlite
      .prepare('SELECT id, state, result FROM command_intents WHERE idempotency_key = ?')
      .get(turnId) as { id: string; state: string; result: string | null } | undefined
    if (!row) {
      changed += Number(
        sqlite
          .prepare(
            `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, last_error, created_at, updated_at)
             VALUES (?, ?, ?, '{}', 'failed', ?, ?, ?)`,
          )
          .run(`retired-inherited-${turnId}`, CODING_INTENT_KIND, turnId, note, now, now).changes,
      )
    } else if (!(row.state === 'failed' || (row.state === 'accepted' && row.result)))
      changed += Number(
        sqlite
          .prepare(
            `UPDATE command_intents SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
          )
          .run(note, now, row.id).changes,
      )
  }
  for (const runId of retired.processes)
    for (const table of ['coding_processes', 'coding_process_members', 'coding_pending_terminals'])
      changed += Number(sqlite.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId).changes)
  for (const attemptId of retired.attempts) {
    const attempt = sqlite
      .prepare('SELECT orchestration_id, step_id, state FROM orc_attempts WHERE id = ?')
      .get(attemptId) as
      { orchestration_id: string; step_id: string | null; state: string } | undefined
    if (!attempt) continue
    // Whatever the source had in flight is its own: an unsent attempt is never sent, a running one's run handle and owed
    // Stop never act on the source's run. Terminal rows keep their evidence.
    if (!['created', 'send_started', 'running', 'unknown', 'abandoned'].includes(attempt.state))
      continue
    const result = sqlite
      .prepare(
        `UPDATE orc_attempts SET state = CASE WHEN state IN ('created', 'send_started', 'running') THEN 'unknown' ELSE state END,
           unknown_reason = 'inherited_retired', sent_at = COALESCE(sent_at, ?),
           stop_acknowledged_at = CASE WHEN stop_requested_at IS NOT NULL THEN COALESCE(stop_acknowledged_at, ?) ELSE stop_acknowledged_at END,
           updated_at = ?
         WHERE id = ? AND (state IN ('created', 'send_started', 'running') OR unknown_reason IS NOT 'inherited_retired'
           OR (stop_requested_at IS NOT NULL AND stop_acknowledged_at IS NULL))`,
      )
      .run(now, now, now, attemptId)
    if (Number(result.changes) === 0) continue
    changed++
    if (attempt.step_id)
      sqlite
        .prepare(
          "UPDATE orc_steps SET status = 'unknown', disposition = 'inherited_retired', updated_at = ? WHERE orchestration_id = ? AND id = ? AND status = 'admitted'",
        )
        .run(now, attempt.orchestration_id, attempt.step_id)
  }
  return changed
}

/** Every start intent that had not finished when the database was copied belongs to the source, not to the copy. */
function retireCopiedIntents(sqlite: DatabaseSync, now: string): number {
  return Number(
    sqlite
      .prepare(
        `UPDATE command_intents SET state = 'failed', last_error = ?, updated_at = ?
         WHERE kind = ? AND state IN ('pending', 'sent', 'unknown')`,
      )
      .run(
        'This database was copied from another installation; its pending coding turns are never sent here.',
        now,
        CODING_INTENT_KIND,
      ).changes,
  )
}

/** Whether the journal's evidence has made this turn permanently unsendable (admission and release check this). */
export function turnWitnessed(sqlite: DatabaseSync, turnId: string): boolean {
  return (
    sqlite
      .prepare('SELECT 1 FROM coding_launches WHERE turn_id = ? AND unsendable = 1 LIMIT 1')
      .get(turnId) !== undefined
  )
}

export function readCheckpoint(sqlite: DatabaseSync): number {
  const row = sqlite.prepare('SELECT seq FROM coding_journal_checkpoint WHERE id = 1').get() as
    { seq: number } | undefined
  return row?.seq ?? 0
}

/** The projection `CodingJournal` calls inside its critical section: the launch row and the checkpoint, one commit. */
export function codingProjection(
  db: ScoreDb,
  clock: () => number = Date.now,
  /** Extra columns the caller keeps beside the journal's state (part 3), written in the same commit. */
  extra?: (sqlite: DatabaseSync, state: CodingState) => void,
): Projection {
  return (entry: JournalEntry, state: CodingState) => {
    const now = new Date(clock()).toISOString()
    db.tx((sqlite) => {
      upsertLaunch(sqlite, { state, kind: kindOf(entry), n: entry.n }, now)
      extra?.(sqlite, state)
      sqlite
        .prepare(
          'UPDATE coding_journal_checkpoint SET seq = MAX(seq, ?), updated_at = ? WHERE id = 1',
        )
        .run(entry.n, now)
    })
  }
}

function kindOf(entry: JournalEntry): CodingLaunch['kind'] {
  return (entry.kind === 'coding-tombstone' ? entry.of : entry.kind) as CodingLaunch['kind']
}

/**
 * Journal records the database lacks or is behind on (a crash between the journal append and the projection, or an
 * older backup), and a database that claims more than the journal holds (the journal lost records). Pure read.
 */
export function verifyCoding(
  sqlite: DatabaseSync,
  entries: readonly JournalEntry[],
  accepted: ReadonlySet<number> = new Set(),
): Mismatch[] {
  const mismatches: Mismatch[] = []
  const launches = foldCodingLaunches(entries)
  const journalMax = maxCodingN(entries)
  const dbSeq = readCheckpoint(sqlite)
  const rows = new Map(
    z
      .array(RowSchema)
      .parse(sqlite.prepare(`SELECT ${ROW_COLUMNS} FROM coding_launches`).all())
      .map((row) => [row.launch_id, row] as const),
  )
  for (const [launchId, launch] of launches) {
    if (accepted.has(launch.n)) continue
    if (launch.violation !== undefined)
      mismatches.push({
        kind: 'journal',
        ref: `coding:${launchId}`,
        journalN: launch.n,
        detail: `The journal's records for coding launch ${launchId} break the rules (${launch.violation}); it is treated as possibly executing`,
      })
    const row = rows.get(launchId)
    if (!row || row.journal_n < launch.n)
      mismatches.push({
        kind: 'journal',
        ref: `coding:${launchId}`,
        journalN: launch.n,
        detail: row
          ? `The journal records coding launch ${launchId} as ${launch.kind}, but the database is behind it`
          : `The journal records coding launch ${launchId} (${launch.kind}), but the database has no record of it`,
      })
    else if (row.journal_n > launch.n)
      mismatches.push({
        kind: 'journal',
        ref: `coding:${launchId}`,
        journalN: launch.n,
        detail: `The database holds coding launch ${launchId} at record ${row.journal_n}, past the journal's ${launch.n}: the journal lost records`,
      })
    else {
      const differs = divergence(row, launch.state)
      if (differs.length > 0)
        mismatches.push({
          kind: 'journal',
          ref: `coding:${launchId}`,
          journalN: launch.n,
          detail: `The database and the journal disagree about coding launch ${launchId} at record ${launch.n} (${differs.join(', ')})`,
        })
    }
  }
  // The other direction: a launch the database knows and the journal does not. The journal keeps a permanent record of
  // every launch (a tombstone at least), so the journal lost a witness; newer launches elsewhere don't make up for it.
  for (const row of rows.values())
    if (!launches.has(row.launch_id) && row.journal_n > 0)
      mismatches.push({
        kind: 'journal',
        ref: `coding:${row.launch_id}`,
        journalN: null,
        detail: `The database holds coding launch ${row.launch_id} (record ${row.journal_n}), but the journal has no record of it: the journal lost a witness`,
      })
  if (dbSeq < journalMax) {
    const newest = entries.findLast((entry) => entry.n === journalMax)
    if (!newest || !accepted.has(newest.n))
      mismatches.push({
        kind: 'journal',
        ref: 'coding-checkpoint',
        journalN: journalMax,
        detail: `The database's coding checkpoint (${dbSeq}) is behind the journal (${journalMax}): the database is older than the journal; coding is blocked until reconciled`,
      })
  } else if (dbSeq > journalMax)
    mismatches.push({
      kind: 'journal',
      ref: 'coding-checkpoint',
      journalN: null,
      detail: `The database's coding checkpoint (${dbSeq}) is ahead of the journal (${journalMax}): the journal lost coding records`,
    })
  return mismatches
}

/**
 * Makes the database agree with the journal where the journal is newer: missing launch rows are rebuilt, every launch
 * the journal witnessed executing (or revoked/ended) becomes permanently unsendable, and the checkpoint is set to the
 * journal's. Runs when the person lifts the fence (and at a mismatching start, so nothing waits for the decision).
 * Returns the number of rows changed.
 */
export function applyCodingEvidence(
  sqlite: DatabaseSync,
  entries: readonly JournalEntry[],
  now: string,
  /** The database was copied from another installation: every pending coding intent it holds is the source's. */
  copied: boolean = false,
): number {
  let changed = 0
  const folded = foldCodingLaunches(entries)
  for (const launch of folded.values()) {
    const found = sqlite
      .prepare(`SELECT ${ROW_COLUMNS} FROM coding_launches WHERE launch_id = ?`)
      .get(launch.state.launchId)
    const before = found === undefined ? undefined : RowSchema.parse(found)
    if (!before || before.journal_n < launch.n) {
      upsertLaunch(sqlite, launch, now)
      changed++
    } else if (before.journal_n === launch.n && divergence(before, launch.state).length > 0) {
      // Same record number, different state: the journal's word stands, except that the two safety flags only grow.
      repairLaunch(sqlite, launch, now)
      changed++
    }
    // A launch the journal says executed stays unsendable even if its row was newer in some other respect.
    if (isUnsendable(launch.state)) {
      changed += Number(
        sqlite
          .prepare(
            'UPDATE coding_launches SET unsendable = 1 WHERE launch_id = ? AND unsendable = 0',
          )
          .run(launch.state.launchId).changes,
      )
      // Only an execution retires the turn; a launch revoked before release never ran, its turn may be retried.
      if (launch.state.mayHaveExecuted) changed += retireIntent(sqlite, launch.state, now)
    }
    if (launch.state.inherited) changed += retireInherited(sqlite, launch.state, now)
  }
  if (copied || [...folded.values()].some((launch) => launch.state.inherited))
    changed += retireCopiedIntents(sqlite, now)
  const journalMax = maxCodingN(entries)
  if (readCheckpoint(sqlite) !== journalMax) {
    sqlite
      .prepare('UPDATE coding_journal_checkpoint SET seq = ?, updated_at = ? WHERE id = 1')
      .run(journalMax, now)
    changed++
  }
  return changed
}
