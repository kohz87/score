import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  applyCodingEvidence,
  verifyCoding,
} from '../../src/domain/orchestration/coding-checkpoint.ts'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { ExecutionJournal } from '../../src/domain/orchestration/journal.ts'
import {
  SCOPE,
  clock,
  coding,
  db,
  entriesOf,
  id,
  iso,
  rowOf,
  setupCodingJournal,
  tmp,
  toArmed,
} from './coding-journal-helpers.ts'

// 7.7a part 1 (design v7 §2, §3): coding records, the critical section, tombstones, the DB checkpoint.

setupCodingJournal()

function inheritedJournal() {
  // The records of another installation, rewritten under this scope the way confirm-copy writes them.
  const other = new CodingJournal(new ExecutionJournal(join(tmp.dir, 'src'), 'inst-src', clock))
  other.requestLaunch(id(9))
  other.arm('l9', { unit: 'score-11111111-c-l9', invocationId: 'inv9', cgroup: '/cg/9' })
  const read = other.journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  return read.entries
}

test('FY2 #2: an inherited launch is evidence only: never owned, never acted on, and its turn is never sent here', () => {
  const lines = inheritedJournal().map((e) => ({ ...e, scope: SCOPE, inherited: true }))
  // Written the way installation.ts writes the copy: scope rewritten, flag set, fresh checksums.
  const copyJournal = new CodingJournal(new ExecutionJournal(join(tmp.dir, 'copy'), SCOPE, clock))
  // Build the file through the public path: inherited state rides in the record.
  const writer = new ExecutionJournal(join(tmp.dir, 'copy'), SCOPE, clock)
  for (const entry of lines) {
    const body = Object.fromEntries(
      Object.entries(entry).filter(([key]) => !['n', 'at', 'scope'].includes(key)),
    )
    writer.append(body as Parameters<typeof writer.append>[0])
  }
  expect(copyJournal.state('l9')!.state.inherited).toBe(true)
  expect(copyJournal.isOwned('l9')).toBe(false)
  expect(coding.isOwned('l1')).toBe(false)
  for (const attempt of [
    copyJournal.recordStop('l9', 'user'),
    copyJournal.waive('l9', 'person'),
    copyJournal.release('l9', () => true),
    copyJournal.ended('l9', {}),
  ])
    expect(attempt).toMatchObject({ ok: false, reason: 'inherited' })
  // The same turn under a new launch id is witnessed even though the source never released it.
  expect(copyJournal.requestLaunch({ ...id(9), launchId: 'mine' })).toMatchObject({
    ok: false,
    reason: 'turn_witnessed',
  })
  // Owned launches stay owned.
  toArmed()
  expect(coding.isOwned('l1')).toBe(true)
})

test('FV #1: reconciling inherited launches marks them unsendable and nothing else (the frozen home does the holding)', () => {
  const entries = inheritedJournal().map(
    (e) =>
      ({ ...e, scope: SCOPE, inherited: true }) as unknown as ReturnType<typeof entriesOf>[number],
  )
  db.sqlite.exec(`
    INSERT INTO coding_launches (launch_id, run_id, turn_id, generation, phase, journal_n, updated_at, held, unit)
      VALUES ('l9', 'r9', 't9', 1, 'armed', 2, 'x', 1, 'score-11111111-c-l9');
    INSERT INTO coding_processes (run_id, pid, pgid, created_at) VALUES ('r9', 4242, 4242, 'x');
    INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at)
      VALUES ('i10', 'start_coding_run', 'unrelated', '{}', 'pending', 'x', 'x');
  `)
  expect(
    verifyCoding(db.sqlite, entries)
      .map((m) => m.detail)
      .join(),
  ).toMatch(/inherited/)
  applyCodingEvidence(db.sqlite, entries, iso())
  expect(rowOf('l9')).toMatchObject({ inherited: 1, unsendable: 1 })
  // No automatic retirement any more: the process row and the pending intent are left for `reset-history`.
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM coding_processes').get()).toEqual({ n: 1 })
  expect(db.sqlite.prepare('SELECT state FROM command_intents WHERE id = ?').get('i10')).toEqual({
    state: 'pending',
  })
  expect(verifyCoding(db.sqlite, entries)).toEqual([])
})
