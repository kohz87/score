import { join } from 'node:path'
import { afterEach, beforeEach, expect } from 'vitest'
import type { ScoreDb } from '../../src/db/index.ts'
import { codingProjection } from '../../src/domain/orchestration/coding-checkpoint.ts'
import { CodingJournal } from '../../src/domain/orchestration/coding-journal.ts'
import { ExecutionJournal } from '../../src/domain/orchestration/journal.ts'
import { openMigrated, tempDir } from './harness-db.ts'

export let tmp: ReturnType<typeof tempDir>
export let db: ScoreDb
export let dir: string
export let now: number
export const clock = () => now
export const SCOPE = 'inst-a'
export const id = (n = 1) => ({ launchId: `l${n}`, runId: `r${n}`, turnId: `t${n}`, generation: 1 })
export const journalAt = (path = dir) => new ExecutionJournal(path, SCOPE, clock)
export let journal: ExecutionJournal
export let coding: CodingJournal
export let project: ReturnType<typeof codingProjection>

export function setupCodingJournal() {
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
}

export const rowOf = (launchId: string) =>
  db.sqlite.prepare('SELECT * FROM coding_launches WHERE launch_id = ?').get(launchId) as
    Record<string, unknown> | undefined

export function toArmed(n = 1) {
  expect(coding.requestLaunch(id(n), project).ok).toBe(true)
  const armed = coding.arm(
    `l${n}`,
    { unit: `score-u${n}`, invocationId: `inv${n}`, cgroup: `/cg/${n}` },
    project,
  )
  expect(armed.ok).toBe(true)
}

export const entriesOf = () => {
  const read = journal.readOwn()
  if (!read.ok) throw new Error(read.reason)
  return read.entries
}

export const iso = () => new Date(now).toISOString()
