import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ScoreDb } from '../../src/db/index.ts'
import {
  applyCodingEvidence,
  codingProjection,
  readCheckpoint,
  turnWitnessed,
  verifyCoding,
} from '../../src/domain/orchestration/coding-checkpoint.ts'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { foldCodingLaunches } from '../../src/domain/orchestration/coding-records.ts'
import { GlobalFenceStore, readGlobal } from '../../src/domain/orchestration/fence.ts'
import { ExecutionJournal, JOURNAL_FILE } from '../../src/domain/orchestration/journal.ts'
import { LockOrderError } from '../../src/locks/os-lock.ts'
import { withRegistryLock } from '../../src/installation.ts'
import { openMigrated, tempDir } from './harness-db.ts'

// 7.7a part 1 (design v7 §2, §3): coding records, the critical section, tombstones, the DB checkpoint.

const child = fileURLToPath(new URL('../helpers/journal-child.ts', import.meta.url))
let tmp: ReturnType<typeof tempDir>
let db: ScoreDb
let dir: string
let now: number
const clock = () => now
const SCOPE = 'inst-a'
const id = (n = 1) => ({ launchId: `l${n}`, runId: `r${n}`, turnId: `t${n}`, generation: 1 })
const journalAt = (path = dir) => new ExecutionJournal(path, SCOPE, clock)
let journal: ExecutionJournal
let coding: CodingJournal
let project: ReturnType<typeof codingProjection>
const rowOf = (launchId: string) =>
  db.sqlite.prepare('SELECT * FROM coding_launches WHERE launch_id = ?').get(launchId) as
    Record<string, unknown> | undefined

beforeEach(() => {
  tmp = tempDir('coding-journal-')
  dir = join(tmp.dir, 'ns')
  db = openMigrated(tmp.dir)
  now = Date.parse('2026-10-12T10:00:00.000Z')
  journal = journalAt()
  coding = new CodingJournal(journal)
  project = codingProjection(db, clock)
})
afterEach(() => {
  db.close()
  tmp.cleanup()
})

function toArmed(n = 1) {
  expect(coding.requestLaunch(id(n), project).ok).toBe(true)
  const armed = coding.arm(
    `l${n}`,
    { unit: `score-u${n}`, invocationId: `inv${n}`, cgroup: `/cg/${n}` },
    project,
  )
  expect(armed.ok).toBe(true)
}

test('the full lifecycle journals every phase with the full state and projects it to the database', () => {
  toArmed()
  expect(coding.release('l1', () => true, project).ok).toBe(true)
  expect(coding.releasedSeen('l1', {}, project).ok).toBe(true)
  expect(coding.ended('l1', { proof: 'cgroup-empty' }, project).ok).toBe(true)
  const settled = coding.settled('l1', { disposition: 'completed' }, project)
  expect(settled.ok).toBe(true)
  const read = journal.readOwn()
  expect(read.ok && read.entries.map((e) => e.kind)).toEqual([
    'launch-requested',
    'armed',
    'releasing',
    'released-seen',
    'ended',
    'settled',
  ])
  const state = coding.state('l1')!.state
  expect(state).toMatchObject({
    runId: 'r1',
    turnId: 't1',
    generation: 1,
    phase: 'settled',
    revoked: false,
    mayHaveExecuted: true,
    unit: 'score-u1',
    invocationId: 'inv1',
    cgroup: '/cg/1',
    proof: 'cgroup-empty',
    disposition: 'completed',
  })
  expect(rowOf('l1')).toMatchObject({
    phase: 'settled',
    may_have_executed: 1,
    unsendable: 1,
    journal_n: 6,
  })
  expect(readCheckpoint(db.sqlite)).toBe(6)
})

test('illegal order, repeats, identity changes and unknown launches are rejected without a record', () => {
  expect(coding.arm('l1', {}, project)).toMatchObject({ ok: false, reason: 'unknown_launch' })
  coding.requestLaunch(id(), project)
  expect(coding.requestLaunch(id(), project)).toMatchObject({
    ok: false,
    reason: 'illegal_transition',
  })
  expect(coding.release('l1', () => true, project)).toMatchObject({
    ok: false,
    reason: 'illegal_transition',
  })
  expect(coding.requestLaunch({ ...id(), runId: 'other' }, project)).toMatchObject({
    ok: false,
    reason: 'identity_mismatch',
  })
  const read = journal.readOwn()
  expect(read.ok && read.entries).toHaveLength(1)
})

test('release is refused when the run is no longer authorised (re-evaluated under the lock) and leaves no record', () => {
  toArmed()
  expect(coding.release('l1', () => false, project)).toMatchObject({
    ok: false,
    reason: 'not_authorised',
  })
  expect(coding.state('l1')!.kind).toBe('armed')
  expect(coding.state('l1')!.state.mayHaveExecuted).toBe(false)
})

test('race, revoke first: a later release fails and the launch never may-have-executed', () => {
  toArmed()
  expect(coding.revoke('l1', undefined, project).ok).toBe(true)
  expect(coding.release('l1', () => true, project)).toMatchObject({ ok: false, reason: 'revoked' })
  const state = coding.state('l1')!.state
  expect(state.revoked).toBe(true)
  expect(state.mayHaveExecuted).toBe(false)
  // A revoked launch can still be ended and settled (its unit, if any, must be proven gone).
  expect(coding.ended('l1', { proof: 'receipts' }, project).ok).toBe(true)
  expect(coding.settled('l1', { disposition: 'revoked' }, project).ok).toBe(true)
  // ...but never requested or armed again.
  expect(coding.requestLaunch(id(), project)).toMatchObject({ ok: false })
})

test('race, release first: revoke is a Stop of a possibly-executing run, never "never ran"', () => {
  toArmed()
  expect(coding.release('l1', () => true, project).ok).toBe(true)
  const revoked = coding.revoke('l1', undefined, project)
  expect(revoked).toMatchObject({ ok: false, reason: 'may_have_executed' })
  expect(coding.state('l1')!.state).toMatchObject({ revoked: false, mayHaveExecuted: true })
})

test('revoking a launch that has no record yet journals a revocation: it can never be requested afterwards', () => {
  expect(coding.revoke('l9', id(9), project).ok).toBe(true)
  expect(coding.requestLaunch(id(9), project)).toMatchObject({ ok: false, reason: 'revoked' })
})

test('the race across two processes: a revoke waiting on the lock sees the release that won', async () => {
  toArmed()
  const marker = join(tmp.dir, 'child-started')
  let exited: Promise<{ out: string }> | undefined
  const result = coding.release(
    'l1',
    () => true,
    () => {
      // Inside the critical section, after `releasing` is durable and before the lock is released: a second process
      // asks to revoke the same launch. It must wait for the lock and then find `releasing`.
      const proc = spawn(
        process.execPath,
        [
          '--experimental-transform-types',
          '--no-warnings',
          child,
          'revoke',
          dir,
          'l1',
          marker,
          SCOPE,
        ],
        {
          env: { ...process.env, XDG_STATE_HOME: join(tmp.dir, 'state') },
        },
      )
      let out = ''
      proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
      exited = new Promise((resolve) => proc.on('close', () => resolve({ out })))
      const deadline = Date.now() + 15_000
      while (!existsSync(marker) && Date.now() < deadline)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      // Give the child time to block on the lock.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    },
  )
  expect(result.ok).toBe(true)
  const { out } = await exited!
  expect(JSON.parse(out.trim().split('\n').at(-1)!)).toEqual({
    ok: false,
    reason: 'may_have_executed',
  })
  expect(coding.state('l1')!.state.revoked).toBe(false)
}, 30_000)

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
