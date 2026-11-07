import { expect, test } from 'vitest'
import { verifyCoding } from '../../src/domain/orchestration/coding-checkpoint.ts'
import { ExecutionJournal } from '../../src/domain/orchestration/journal.ts'
import { LockOrderError } from '../../src/locks/os-lock.ts'
import { withRegistryLock } from '../../src/installation.ts'
import {
  SCOPE,
  clock,
  coding,
  db,
  dir,
  journal,
  project,
  setupCodingJournal,
  tmp,
  toArmed,
} from './coding-journal-helpers.ts'

// 7.7a part 1 (design v7 §2, §3): coding records, the critical section, tombstones, the DB checkpoint.

setupCodingJournal()

test('projection failure after the record is durable: no go, the launch stays "may have executed"', () => {
  toArmed()
  const failing = () => {
    throw new Error('database is locked')
  }
  const result = coding.release('l1', () => true, failing)
  expect(result).toMatchObject({ ok: false, reason: 'projection_failed' })
  const launch = coding.state('l1')!
  expect(launch.kind).toBe('releasing')
  expect(launch.state.mayHaveExecuted).toBe(true)
  // A later revocation cannot turn it into no-launch.
  expect(coding.revoke('l1', undefined, project)).toMatchObject({
    ok: false,
    reason: 'may_have_executed',
  })
  // The database lags: the checkpoint is behind and the mismatch is reported.
  const entries = journal.readOwn()
  expect(entries.ok && verifyCoding(db.sqlite, entries.entries).map((m) => m.ref)).toContain(
    'coding-checkpoint',
  )
})

test('critical holds the journal lock across read, CAS, append and projection (another handle cannot enter)', () => {
  toArmed()
  const other = new ExecutionJournal(dir, SCOPE, clock, undefined, undefined, 50)
  let sawLockBusy = false
  journal.critical((tx) => {
    expect(tx.launch('l1')!.kind).toBe('armed')
    // A second handle in another connection cannot get the lock while we are inside.
    try {
      other.critical(() => undefined)
    } catch (error) {
      sawLockBusy = error instanceof LockOrderError || /lock/i.test(String(error))
    }
  })
  expect(sawLockBusy).toBe(true)
})

test('lock order: the registry lock cannot be taken while a journal lock is held', () => {
  expect(() => journal.critical(() => withRegistryLock(tmp.dir, () => undefined))).toThrow(
    LockOrderError,
  )
  // The legal order works.
  expect(withRegistryLock(tmp.dir, () => journal.critical(() => 'ok'))).toBe('ok')
})
