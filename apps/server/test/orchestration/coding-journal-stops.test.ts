import { expect, test } from 'vitest'
import {
  applyCodingEvidence,
  verifyCoding,
} from '../../src/domain/orchestration/coding-checkpoint.ts'
import {
  coding,
  db,
  entriesOf,
  id,
  iso,
  journal,
  journalAt,
  project,
  rowOf,
  setupCodingJournal,
  toArmed,
} from './coding-journal-helpers.ts'

// 7.7a part 1 (design v7 §2, §3): coding records, the critical section, tombstones, the DB checkpoint.

setupCodingJournal()

test('FY2 #14: recordStop journals the first cause before any signal; first cause wins; the database projects it', () => {
  toArmed()
  coding.release('l1', () => true, project)
  const first = coding.recordStop('l1', 'user', project)
  expect(first).toMatchObject({ ok: true, state: { stopCause: 'user', phase: 'releasing' } })
  // The record is already on disk when it returns (a second handle reads it).
  const last = journalAt().readOwn()
  expect(last.ok && last.entries.at(-1)).toMatchObject({
    kind: 'stop-requested',
    stopCause: 'user',
  })
  expect(coding.recordStop('l1', 'deadline', project)).toMatchObject({
    ok: true,
    state: { stopCause: 'user' },
  })
  expect(rowOf('l1')).toMatchObject({ stop_cause: 'user' })
  // The phase machine is unaffected: the launch still ends and settles normally.
  expect(coding.ended('l1', { proof: 'cgroup-empty' }, project).ok).toBe(true)
  expect(coding.settled('l1', { disposition: 'stopped' }, project).ok).toBe(true)
  expect(coding.recordStop('l1', 'user', project)).toMatchObject({
    ok: false,
    reason: 'illegal_transition',
  })
  expect(coding.recordStop('nope', 'user')).toMatchObject({ ok: false, reason: 'unknown_launch' })
})

test('FY2 #14: a stop cause survives a restored database and compaction; a revoked launch can still be stopped', () => {
  toArmed()
  coding.release('l1', () => true, project)
  coding.recordStop('l1', 'user', project)
  db.sqlite.exec('DELETE FROM coding_launches; UPDATE coding_journal_checkpoint SET seq = 0')
  applyCodingEvidence(db.sqlite, entriesOf(), iso())
  expect(rowOf('l1')).toMatchObject({ stop_cause: 'user' })
  journal.compact(() => true)
  const folded = coding.state('l1')!
  expect(folded.state.stopCause).toBe('user')
  expect(folded.kind).toBe('releasing') // the annotation did not change the phase kind
  expect(coding.ended('l1', { proof: 'cgroup-empty' }, project).ok).toBe(true)
  // Revoked before release: stoppable, never releasable.
  expect(coding.requestLaunch(id(2), project).ok).toBe(true)
  expect(coding.revoke('l2', undefined, project).ok).toBe(true)
  expect(coding.recordStop('l2', 'user', project).ok).toBe(true)
  expect(coding.release('l2', () => true, project)).toMatchObject({ ok: false, reason: 'revoked' })
})

test('FY2 #8: waive settles the launch for good, in one critical section, and survives compaction', () => {
  toArmed()
  coding.release('l1', () => true, project)
  const waived = coding.waive('l1', 'person', project)
  expect(waived).toMatchObject({
    ok: true,
    state: { phase: 'settled', disposition: 'waived', waiver: true, waivedBy: 'person' },
  })
  expect(rowOf('l1')).toMatchObject({
    phase: 'settled',
    disposition: 'waived',
    waiver: 1,
    unsendable: 1,
  })
  // Nothing acts on it again.
  for (const attempt of [
    coding.recordStop('l1', 'user'),
    coding.ended('l1', { proof: 'x' }),
    coding.settled('l1', {}),
    coding.waive('l1', 'again'),
  ])
    expect(attempt).toMatchObject({ ok: false, reason: 'illegal_transition' })
  journal.compact(() => true)
  expect(entriesOf().at(-1)).toMatchObject({ kind: 'coding-tombstone', of: 'waived' })
  expect(coding.state('l1')!.state).toMatchObject({ disposition: 'waived', waiver: true })
  // A database that lost the waiver is repaired from the journal (equal record number, different state).
  db.sqlite
    .prepare("UPDATE coding_launches SET waiver = 0, disposition = NULL WHERE launch_id = 'l1'")
    .run()
  expect(verifyCoding(db.sqlite, entriesOf()).map((m) => m.ref)).toContain('coding:l1')
  applyCodingEvidence(db.sqlite, entriesOf(), iso())
  expect(rowOf('l1')).toMatchObject({ waiver: 1, disposition: 'waived' })
})
