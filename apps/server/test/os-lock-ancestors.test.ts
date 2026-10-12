import { mkdtempSync, readlinkSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ExecutionJournal } from '../src/domain/orchestration/journal.ts'
import { OsLock } from '../src/locks/os-lock.ts'

// EE1 (7.7a v6 review #1): every ancestor the lock or the journal creates is synced, whichever entry point runs first.

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'score-anc-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** An fsync that records which directory each call synced. */
const recorder = (failOn?: string) => {
  const synced: string[] = []
  let failed = false
  return {
    synced,
    fsync: (fd: number) => {
      const path = readlinkSync(`/proc/self/fd/${fd}`)
      if (failOn && path === failOn && !failed) {
        failed = true
        throw new Error('injected fsync failure')
      }
      synced.push(path)
    },
  }
}
const io = (fsync: (fd: number) => void) => ({
  writeSync: (fd: number, b: Buffer, o: number, l: number) => writeSync(fd, b, o, l),
  fsyncSync: fsync,
})

test('EE1: the OS lock syncs the parent of every directory it creates, before the lock file exists', () => {
  const dir = join(root, 'a', 'b', 'journal')
  const rec = recorder()
  const lock = new OsLock(dir, rec.fsync)
  lock.runSync(() => undefined)
  lock.close()
  for (const parent of [root, join(root, 'a'), join(root, 'a', 'b')])
    expect(rec.synced).toContain(parent)
})

test('EE1: the real startup order (restore marker read before open) still syncs the ancestors', () => {
  const dir = join(root, 'x', 'y', 'journal')
  const rec = recorder()
  const journal = new ExecutionJournal(dir, 'home', Date.now, undefined, io(rec.fsync))
  journal.readRestoreMarker() // takes the lock first, which creates the directory
  journal.open()
  journal.append({ kind: 'global_fence', action: 'set', fenceSeq: 1, reason: 'x' })
  for (const parent of [root, join(root, 'x'), join(root, 'x', 'y')])
    expect(rec.synced).toContain(parent)
})

test('EE1: a failed ancestor sync is retried by a fresh handle before it appends', () => {
  const dir = join(root, 'p', 'q', 'journal')
  const failing = recorder(join(root, 'p'))
  const first = new ExecutionJournal(dir, 'home', Date.now, undefined, io(failing.fsync))
  expect(() => first.open()).toThrow(/injected/)
  const good = recorder()
  const second = new ExecutionJournal(dir, 'home', Date.now, undefined, io(good.fsync))
  second.append({ kind: 'global_fence', action: 'set', fenceSeq: 1, reason: 'x' })
  expect(good.synced).toContain(join(root, 'p'))
})
