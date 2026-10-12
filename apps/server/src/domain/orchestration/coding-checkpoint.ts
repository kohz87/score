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

const RowSchema = z.object({
  launch_id: z.string(),
  journal_n: z.int(),
  unsendable: z.int(),
})

/** A launch that was released, revoked or ended can never be sent again, whatever happens to any fence. */
export function isUnsendable(state: CodingState): boolean {
  return (
    state.mayHaveExecuted || state.revoked || state.phase === 'ended' || state.phase === 'settled'
  )
}

function upsertLaunch(sqlite: DatabaseSync, launch: CodingLaunch, now: string): void {
  const s = launch.state
  sqlite
    .prepare(
      `INSERT INTO coding_launches (launch_id, run_id, turn_id, generation, phase, revoked, may_have_executed, unit,
         invocation_id, cgroup, proof, disposition, waiver, journal_n, unsendable, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (launch_id) DO UPDATE SET phase = excluded.phase, revoked = excluded.revoked,
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
      launch.n,
      isUnsendable(s) ? 1 : 0,
      now,
    )
}

export function readCheckpoint(sqlite: DatabaseSync): number {
  const row = sqlite.prepare('SELECT seq FROM coding_journal_checkpoint WHERE id = 1').get() as
    { seq: number } | undefined
  return row?.seq ?? 0
}

/** The projection `CodingJournal` calls inside its critical section: the launch row and the checkpoint, one commit. */
export function codingProjection(db: ScoreDb, clock: () => number = Date.now): Projection {
  return (entry: JournalEntry, state: CodingState) => {
    const now = new Date(clock()).toISOString()
    db.tx((sqlite) => {
      upsertLaunch(sqlite, { state, kind: kindOf(entry), n: entry.n }, now)
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
      .parse(sqlite.prepare('SELECT launch_id, journal_n, unsendable FROM coding_launches').all())
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
  }
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
): number {
  let changed = 0
  for (const launch of foldCodingLaunches(entries).values()) {
    const before = sqlite
      .prepare('SELECT journal_n FROM coding_launches WHERE launch_id = ?')
      .get(launch.state.launchId) as { journal_n: number } | undefined
    if (!before || before.journal_n < launch.n) {
      upsertLaunch(sqlite, launch, now)
      changed++
    }
    // A launch the journal says executed stays unsendable even if its row was newer in some other respect.
    if (isUnsendable(launch.state))
      changed += Number(
        sqlite
          .prepare(
            'UPDATE coding_launches SET unsendable = 1 WHERE launch_id = ? AND unsendable = 0',
          )
          .run(launch.state.launchId).changes,
      )
  }
  const journalMax = maxCodingN(entries)
  if (readCheckpoint(sqlite) !== journalMax) {
    sqlite
      .prepare('UPDATE coding_journal_checkpoint SET seq = ?, updated_at = ? WHERE id = 1')
      .run(journalMax, now)
    changed++
  }
  return changed
}
