import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { ScoreDb } from '../../src/db/index.ts'
import {
  applyCodingEvidence,
  codingProjection,
  verifyCoding,
} from '../../src/domain/orchestration/coding-checkpoint.ts'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { foldCodingLaunches } from '../../src/domain/orchestration/coding-records.ts'
import { ExecutionJournal } from '../../src/domain/orchestration/journal.ts'
import { openMigrated, tempDir } from './harness-db.ts'

// 7.7b-1 #3 (M4): the coding journal's `requested` record carries the immutable owner; the projection row and the
// tombstone keep it through compaction, and the revoke cause is permanent too.

let tmp: ReturnType<typeof tempDir>
let db: ScoreDb
let journal: ExecutionJournal
let coding: CodingJournal
let project: ReturnType<typeof codingProjection>
const owner = { orchestrationId: 'orc-1', attemptId: 'att-1', generation: 2 }
const id = (n: number) => ({ launchId: `l${n}`, runId: `r${n}`, turnId: `t${n}`, generation: 2 })
const row = (launchId: string) =>
  db.sqlite.prepare('SELECT * FROM coding_launches WHERE launch_id = ?').get(launchId) as Record<
    string,
    unknown
  >

beforeEach(() => {
  tmp = tempDir('coding-owner-')
  db = openMigrated(tmp.dir)
  journal = new ExecutionJournal(join(tmp.dir, 'ns'), 'inst-a')
  coding = new CodingJournal(journal)
  project = codingProjection(db)
})
afterEach(() => {
  db.close()
  tmp.cleanup()
})

test('the owner is written by the requested record, projected, and cannot be replaced later', () => {
  expect(coding.requestLaunch(id(1), project, { owner }).ok).toBe(true)
  expect(coding.state('l1')!.state.owner).toEqual(owner)
  expect(row('l1')).toMatchObject({
    owner_orchestration: 'orc-1',
    owner_attempt: 'att-1',
    owner_generation: 2,
  })
  // A later record that tries to name another owner leaves the first one in place.
  const armed = coding.arm(
    'l1',
    {
      unit: 'u1',
      invocationId: 'i1',
      cgroup: '/cg/1',
      owner: { ...owner, orchestrationId: 'other' },
    },
    project,
  )
  expect(armed.ok).toBe(true)
  expect(coding.state('l1')!.state.owner).toEqual(owner)
})

test('the owner and the revoke cause survive release, revocation, settlement and compaction', () => {
  coding.requestLaunch(id(1), project, { owner })
  coding.arm('l1', { unit: 'u1', invocationId: 'i1', cgroup: '/cg/1' }, project)
  expect(coding.revoke('l1', undefined, project, 'paused').ok).toBe(true)
  coding.ended('l1', { proof: 'cgroup-empty' }, project)
  coding.settled('l1', { disposition: 'revoked' }, project)
  coding.requestLaunch(id(2), project, { owner: { ...owner, generation: 3 } })
  coding.arm('l2', { unit: 'u2', invocationId: 'i2', cgroup: '/cg/2' }, project)
  coding.release('l2', () => true, project)
  coding.releasedSeen('l2', {}, project)
  coding.ended('l2', { proof: 'cgroup-empty' }, project)
  coding.settled('l2', { disposition: 'completed' }, project)
  journal.compact(() => true)
  const read = journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  // Both settled launches are tombstones now, and the tombstones still carry who owns them and why l1 was revoked.
  expect(read.entries.filter((entry) => entry.kind === 'coding-tombstone')).toHaveLength(2)
  const folded = foldCodingLaunches(read.entries)
  expect(folded.get('l1')!.state).toMatchObject({ owner, revoked: true, revokeCause: 'paused' })
  expect(folded.get('l1')!.state.mayHaveExecuted).toBe(false)
  expect(folded.get('l2')!.state).toMatchObject({
    owner: { ...owner, generation: 3 },
    mayHaveExecuted: true,
  })
  // A database that lost its rows is rebuilt from the tombstones, owner and cause included.
  db.sqlite.prepare('DELETE FROM coding_launches').run()
  expect(applyCodingEvidence(db.sqlite, read.entries, new Date().toISOString())).toBeGreaterThan(0)
  expect(row('l1')).toMatchObject({ owner_orchestration: 'orc-1', revoke_cause: 'paused' })
  expect(row('l2')).toMatchObject({ owner_generation: 3, revoke_cause: null })
  expect(verifyCoding(db.sqlite, read.entries)).toEqual([])
})

test('a database that disagrees about the owner or the revoke cause is a divergence', () => {
  coding.requestLaunch(id(1), project, { owner })
  coding.revoke('l1', undefined, project, 'stop')
  const read = journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  db.sqlite.prepare("UPDATE coding_launches SET owner_orchestration = 'other'").run()
  expect(
    verifyCoding(db.sqlite, read.entries)
      .map((m) => m.detail)
      .join(' '),
  ).toContain('owner')
  db.sqlite
    .prepare("UPDATE coding_launches SET owner_orchestration = 'orc-1', revoke_cause = 'paused'")
    .run()
  expect(
    verifyCoding(db.sqlite, read.entries)
      .map((m) => m.detail)
      .join(' '),
  ).toContain('revoke cause')
})
