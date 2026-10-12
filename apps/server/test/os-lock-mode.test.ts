import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { LOCK_FILE_NAME, OsLock } from '../src/locks/os-lock.ts'

// AA5: the lock sidecar is owner-only.
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-lockmode-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const mode = () => statSync(join(dir, LOCK_FILE_NAME)).mode & 0o777

test('AA5: a new lock file is 0600', () => {
  const lock = new OsLock(dir)
  lock.runSync(() => undefined)
  lock.close()
  expect(mode()).toBe(0o600)
})

test('AA5: an existing lock file with wider bits is narrowed to 0600', () => {
  writeFileSync(join(dir, LOCK_FILE_NAME), '')
  chmodSync(join(dir, LOCK_FILE_NAME), 0o644)
  const lock = new OsLock(dir)
  lock.runSync(() => undefined)
  lock.close()
  expect(mode()).toBe(0o600)
})
