import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import {
  MAX_POLICY_SNAPSHOT_BYTES,
  readWorkerPolicy,
  storeWorkerPolicy,
} from '../../src/domain/orchestration/coding-policy.ts'
import type { WorkerPolicy } from '../../src/runtimes/coding/policy.ts'

// A worker policy snapshot records paths (CLI binary, workspace, settings files). With ordinary home paths it was
// ~3.5 KB, so the former 4 KB cap failed every coding worker of anyone with a longer home or workspace path.
let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-policy-size-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  // Only the snapshot row is under test: no orchestration row behind it.
  db.sqlite.exec('PRAGMA foreign_keys = OFF')
})
afterEach(() => {
  db.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

const policyWithWorkspace = (path: string) =>
  ({
    v: 1,
    runtime: 'claude-code',
    workspace: { real: path, dev: 1, ino: 2 },
  }) as unknown as WorkerPolicy
const store = (policy: WorkerPolicy) =>
  storeWorkerPolicy(
    db.sqlite,
    'orc-1',
    'coder',
    {
      policyId: 'p1',
      policy,
      reach: 'its workspace',
      reachBeyondWorkspace: false,
      acknowledged: false,
    },
    new Date().toISOString(),
  )

test('a snapshot with a long workspace path (over 4 KB) is stored and read back', () => {
  const longPath = `/home/someone.with.a.long.name/${'projects/'.repeat(500)}ws`
  store(policyWithWorkspace(longPath))
  const read = readWorkerPolicy(db.sqlite, 'orc-1', 'coder')
  expect(JSON.stringify(read?.policy).length).toBeGreaterThan(4096)
  expect((read?.policy as unknown as { workspace: { real: string } }).workspace.real).toBe(longPath)
})

test('a snapshot beyond the sanity bound is still refused', () => {
  const huge = `/${'x'.repeat(MAX_POLICY_SNAPSHOT_BYTES)}`
  expect(() => store(policyWithWorkspace(huge))).toThrow('larger than 64 KB')
})
