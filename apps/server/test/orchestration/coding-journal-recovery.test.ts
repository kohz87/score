import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  applyCodingEvidence,
  readCheckpoint,
  turnWitnessed,
  verifyCoding,
} from '../../src/domain/orchestration/coding-checkpoint.ts'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { foldCodingLaunches } from '../../src/domain/orchestration/coding-records.ts'
import { GlobalFenceStore, readGlobal } from '../../src/domain/orchestration/fence.ts'
import { ExecutionJournal, JOURNAL_FILE } from '../../src/domain/orchestration/journal.ts'
import {
  clock,
  coding,
  db,
  dir,
  entriesOf,
  id,
  iso,
  journal,
  now,
  project,
  rowOf,
  setupCodingJournal,
  toArmed,
} from './coding-journal-helpers.ts'

// 7.7a part 1 (design v7 §2, §3): coding records, the critical section, tombstones, the DB checkpoint.

setupCodingJournal()

test('compaction keeps only the newest record per launch, a settled launch becomes a permanent tombstone', () => {
  toArmed(1)
  coding.release('l1', () => true, project)
  coding.ended('l1', { proof: 'cgroup-empty' }, project)
  coding.settled('l1', { disposition: 'completed' }, project)
  toArmed(2)
  coding.revoke('l2', undefined, project)
  const before = journal.readOwn()
  expect(before.ok && before.entries).toHaveLength(8)
  journal.compact(() => true)
  const after = journal.readOwn()
  if (!after.ok) throw new Error(after.reason)
  expect(after.entries.map((e) => [e.kind, e.n])).toEqual([
    ['coding-tombstone', 5],
    ['revoked', 8],
  ])
  expect(after.entries[0]).toMatchObject({
    of: 'settled',
    launchId: 'l1',
    mayHaveExecuted: true,
    disposition: 'completed',
  })
  // Compacting again never removes a tombstone, whatever the predicate says.
  journal.compact(() => true)
  const again = journal.readOwn()
  expect(again.ok && again.entries.map((e) => e.n)).toEqual([5, 8])
  // The folded state is the same as before compaction.
  const folded = foldCodingLaunches(after.entries)
  expect(folded.get('l1')!.state.mayHaveExecuted).toBe(true)
  expect(folded.get('l2')!.state.revoked).toBe(true)
  // Numbering continues past the compacted entries.
  expect(coding.requestLaunch(id(3), project).ok).toBe(true)
  const next = journal.readOwn()
  expect(next.ok && next.entries.at(-1)!.n).toBe(9)
})

test('a database restored to before `releasing` is behind the journal: it fences, and the launch becomes permanently unsendable', () => {
  toArmed()
  // The backup: the database as it was when the launch was armed.
  const backupRow = rowOf('l1')!
  const backupSeq = readCheckpoint(db.sqlite)
  coding.release('l1', () => true, project)
  // Restore the database to the backed-up state.
  db.sqlite
    .prepare(
      'UPDATE coding_launches SET phase = ?, may_have_executed = 0, unsendable = 0, journal_n = ? WHERE launch_id = ?',
    )
    .run(backupRow.phase as string, backupRow.journal_n as number, 'l1')
  db.sqlite.prepare('UPDATE coding_journal_checkpoint SET seq = ?').run(backupSeq)
  const fence = new GlobalFenceStore(db, journal, clock)
  expect(fence.startupCheck()).toMatchObject({ fenced: true, reasons: ['journal_mismatch'] })
  expect(readGlobal(db.sqlite).fenced).toBe(1)
  // Reconciliation (at the mismatching start already): the journal's word is applied.
  expect(rowOf('l1')).toMatchObject({ phase: 'releasing', may_have_executed: 1, unsendable: 1 })
  expect(readCheckpoint(db.sqlite)).toBe(3)
  // A second start finds nothing new but the fence stays until the person lifts it.
  expect(new GlobalFenceStore(db, journal, clock).startupCheck().fenced).toBe(true)
})

test('rows lost with the database are rebuilt from the journal, unsendable', () => {
  toArmed()
  coding.release('l1', () => true, project)
  db.sqlite.exec('DELETE FROM coding_launches')
  const entries = journal.readOwn()
  if (!entries.ok) throw new Error(entries.reason)
  expect(verifyCoding(db.sqlite, entries.entries).some((m) => m.ref === 'coding:l1')).toBe(true)
  applyCodingEvidence(db.sqlite, entries.entries, new Date(now).toISOString())
  expect(rowOf('l1')).toMatchObject({
    phase: 'releasing',
    unsendable: 1,
    may_have_executed: 1,
    unit: 'score-u1',
  })
  expect(verifyCoding(db.sqlite, entries.entries)).toEqual([])
})

test('a database that is ahead of the journal (journal lost coding records) also fences', () => {
  toArmed()
  const entries = journal.readOwn()
  if (!entries.ok) throw new Error(entries.reason)
  db.sqlite.prepare('UPDATE coding_journal_checkpoint SET seq = 99').run()
  expect(
    verifyCoding(db.sqlite, entries.entries)
      .map((m) => m.detail)
      .join(),
  ).toMatch(/ahead of the journal/)
})

test('a sequence that breaks the rules in the journal is reported and refuses further records', () => {
  toArmed()
  coding.release('l1', () => true, project)
  // Tamper: a `revoked` record after `releasing` (as a forged or buggy writer would append).
  journal.append({ kind: 'revoked', ...coding.state('l1')!.state, revoked: true })
  const entries = journal.readOwn()
  if (!entries.ok) throw new Error(entries.reason)
  expect(foldCodingLaunches(entries.entries).get('l1')!.violation).toMatch(/not a legal transition/)
  expect(
    verifyCoding(db.sqlite, entries.entries)
      .map((m) => m.detail)
      .join(),
  ).toMatch(/break the rules/)
  expect(coding.ended('l1', {}, project)).toMatchObject({ ok: false, reason: 'illegal_transition' })
})

test('coding records written by another scope are never mixed into this installation', () => {
  toArmed()
  const foreign = new ExecutionJournal(dir, 'inst-b', clock)
  new CodingJournal(foreign).requestLaunch({ ...id(), launchId: 'lx' })
  expect(coding.state('lx')).toBeUndefined()
  expect(existsSync(join(dir, JOURNAL_FILE))).toBe(true)
})

test('FX3 #4: a witnessed turn is unsendable, not only its launch: no new launch for it, and its start intent is retired', () => {
  toArmed()
  coding.release('l1', () => true, project)
  // Same turn, new launch id: refused at request time (and at release if a request slipped in before the witness).
  const again = coding.requestLaunch({ ...id(1), launchId: 'l1b' }, project)
  expect(again).toMatchObject({ ok: false, reason: 'turn_witnessed' })
  // A database restored from before: it lost the launch row and the accepted intent, keeping only a pending one.
  db.sqlite.exec('DELETE FROM coding_launches')
  db.sqlite
    .prepare(
      `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
       VALUES ('i1', 'start_coding_run', 't1', '{}', 'pending', 'x', 'x')`,
    )
    .run()
  const entries = journal.readOwn()
  if (!entries.ok) throw new Error(entries.reason)
  applyCodingEvidence(db.sqlite, entries.entries, new Date(now).toISOString())
  expect(
    db.sqlite.prepare("SELECT state FROM command_intents WHERE idempotency_key = 't1'").get(),
  ).toEqual({ state: 'failed' })
  expect(turnWitnessed(db.sqlite, 't1')).toBe(true)
  // And when the database lost the intent altogether, a retired one is written so admission still refuses the turn.
  db.sqlite.exec('DELETE FROM command_intents')
  applyCodingEvidence(db.sqlite, entries.entries, new Date(now).toISOString())
  expect(
    db.sqlite.prepare("SELECT state FROM command_intents WHERE idempotency_key = 't1'").get(),
  ).toEqual({ state: 'failed' })
  // A launch revoked before release never ran: its turn is not retired.
  expect(coding.requestLaunch(id(2), project).ok).toBe(true)
  expect(coding.revoke('l2', undefined, project).ok).toBe(true)
})

test('FX3 #12: reconciliation compares the full state, not the sequence number', () => {
  toArmed()
  coding.release('l1', () => true, project)
  const entries = journal.readOwn()
  if (!entries.ok) throw new Error(entries.reason)
  expect(verifyCoding(db.sqlite, entries.entries)).toEqual([])
  // Same record number, different content.
  db.sqlite
    .prepare(
      "UPDATE coding_launches SET phase = 'armed', invocation_id = 'other', unit = 'x' WHERE launch_id = 'l1'",
    )
    .run()
  const found = verifyCoding(db.sqlite, entries.entries)
  expect(found.map((m) => m.ref)).toContain('coding:l1')
  expect(found.map((m) => m.detail).join()).toMatch(/phase.*unit.*invocation/)
  expect(
    applyCodingEvidence(db.sqlite, entries.entries, new Date(now).toISOString()),
  ).toBeGreaterThan(0)
  expect(rowOf('l1')).toMatchObject({ phase: 'releasing', invocation_id: 'inv1', unit: 'score-u1' })
  expect(verifyCoding(db.sqlite, entries.entries)).toEqual([])
  // A row that is AHEAD of the journal is a divergence too (the journal lost records).
  db.sqlite.prepare('UPDATE coding_launches SET journal_n = 99').run()
  expect(
    verifyCoding(db.sqlite, entries.entries)
      .map((m) => m.detail)
      .join(),
  ).toMatch(/past the journal/)
})

// ---- Second fix round, FY2 ----

test('FY2 #12: a launch the database holds and the journal lost is reported even while newer launches exist; identity divergence is repaired', () => {
  toArmed(1)
  toArmed(2)
  const all = entriesOf()
  // The journal lost launch 1 but keeps the newer launch 2.
  const without = all.filter((e) => (e as { launchId?: string }).launchId !== 'l1')
  expect(verifyCoding(db.sqlite, without).filter((m) => m.ref === 'coding:l1')).toMatchObject([
    { journalN: null, detail: expect.stringMatching(/no record of it/) },
  ])
  // A row whose immutable identity differs from a NEWER journal record is repaired, not left as it was.
  db.sqlite
    .prepare(
      "UPDATE coding_launches SET run_id = 'wrong', turn_id = 'wrong', generation = 7, journal_n = 1 WHERE launch_id = 'l2'",
    )
    .run()
  applyCodingEvidence(db.sqlite, all, iso())
  expect(rowOf('l2')).toMatchObject({ run_id: 'r2', turn_id: 't2', generation: 1 })
})
