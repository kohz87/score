import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { acquireHomeLock } from '../src/db/index.ts'

let home: string
const stalePid = 2147483647
const startedAt = '2026-10-06T12:00:00.000Z'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'score-lock-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

test('exclusive ownership writes a private lock, rejects a live owner, and releases idempotently', () => {
  const lock = acquireHomeLock(home)
  const path = join(home, 'score.lock')
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
    pid: process.pid,
    startedAt: expect.any(String),
    nonce: expect.any(String),
  })
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(() => acquireHomeLock(home)).toThrow(
    `Another Score server (pid ${process.pid}) is using ${home}`,
  )
  lock.release()
  lock.release()
  expect(existsSync(path)).toBe(false)
  acquireHomeLock(home).release()
})

test('a stale pid is replaced atomically with the current owner', () => {
  expect(() => process.kill(stalePid, 0)).toThrow()
  writeFileSync(join(home, 'score.lock'), JSON.stringify({ pid: stalePid, startedAt }), {
    mode: 0o644,
  })
  const lock = acquireHomeLock(home)
  expect(JSON.parse(readFileSync(join(home, 'score.lock'), 'utf8')).pid).toBe(process.pid)
  expect(statSync(join(home, 'score.lock')).mode & 0o777).toBe(0o600)
  expect(existsSync(join(home, 'score.lock.recovery'))).toBe(false)
  lock.release()
})

test('release leaves a replacement owner intact, including a different acquisition by our pid', () => {
  const lock = acquireHomeLock(home)
  const path = join(home, 'score.lock')
  const replacement = JSON.stringify({ pid: stalePid, startedAt })
  writeFileSync(path, replacement)
  lock.release()
  expect(readFileSync(path, 'utf8')).toBe(replacement)
  const newLock = acquireHomeLock(home)
  lock.release()
  expect(existsSync(path)).toBe(true)
  newLock.release()
})

test('permission denial on kill does not count as a stale lock', () => {
  writeFileSync(join(home, 'score.lock'), JSON.stringify({ pid: stalePid, startedAt }))
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
  })
  expect(() => acquireHomeLock(home)).toThrow('Another Score server')
})

test('malformed locks and concurrent stale-lock recovery fail closed', () => {
  writeFileSync(join(home, 'score.lock'), '{}')
  expect(() => acquireHomeLock(home)).toThrow()
  writeFileSync(join(home, 'score.lock'), JSON.stringify({ pid: stalePid, startedAt }))
  writeFileSync(join(home, 'score.lock.recovery'), 'already recovering')
  expect(() => acquireHomeLock(home)).toThrow()
  expect(JSON.parse(readFileSync(join(home, 'score.lock'), 'utf8')).pid).toBe(stalePid)
})

test('release leaves malformed replacement lock content untouched', () => {
  const lock = acquireHomeLock(home)
  const path = join(home, 'score.lock')
  writeFileSync(path, '{}')
  expect(() => lock.release()).not.toThrow()
  expect(readFileSync(path, 'utf8')).toBe('{}')
})

function age(path: string, seconds: number): void {
  const past = new Date(Date.now() - seconds * 1000)
  utimesSync(path, past, past)
}

test('an abandoned recovery file from a crashed contender does not block startup', () => {
  writeFileSync(join(home, 'score.lock'), JSON.stringify({ pid: stalePid, startedAt }))
  writeFileSync(join(home, 'score.lock.recovery'), JSON.stringify({ pid: stalePid, startedAt }))
  const lock = acquireHomeLock(home)
  expect(JSON.parse(readFileSync(join(home, 'score.lock'), 'utf8')).pid).toBe(process.pid)
  expect(existsSync(join(home, 'score.lock.recovery'))).toBe(false)
  lock.release()
})

test('an old unreadable lock or recovery file is stale; a fresh one asks to retry', () => {
  const path = join(home, 'score.lock')
  writeFileSync(path, '')
  expect(() => acquireHomeLock(home)).toThrow('retry in a few seconds')
  age(path, 60)
  writeFileSync(join(home, 'score.lock.recovery'), 'partial')
  age(join(home, 'score.lock.recovery'), 60)
  const lock = acquireHomeLock(home)
  expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid)
  lock.release()
})

test('a lock from before the last boot is stale even if its pid is alive again', () => {
  writeFileSync(join(home, 'score.lock'), JSON.stringify({ pid: process.pid, startedAt }))
  const env = {
    now: () => Date.parse('2026-10-07T09:00:00.000Z'),
    bootTime: () => Date.parse('2026-10-07T08:00:00.000Z'),
    isAlive: () => true,
  }
  const lock = acquireHomeLock(home, env)
  expect(JSON.parse(readFileSync(join(home, 'score.lock'), 'utf8')).startedAt).toBe(
    '2026-10-07T09:00:00.000Z',
  )
  lock.release()
})

test('a live owner from this boot is still rejected', () => {
  writeFileSync(join(home, 'score.lock'), JSON.stringify({ pid: stalePid, startedAt }))
  const env = {
    now: () => Date.parse('2026-10-06T12:05:00.000Z'),
    bootTime: () => Date.parse('2026-10-06T11:00:00.000Z'),
    isAlive: () => true,
  }
  expect(() => acquireHomeLock(home, env)).toThrow(`Another Score server (pid ${stalePid})`)
})

test('a recovery file replaced by another contender is never adopted as our lock', () => {
  const recovery = join(home, 'score.lock.recovery')
  writeFileSync(join(home, 'score.lock'), JSON.stringify({ pid: stalePid, startedAt }))
  const other = JSON.stringify({ pid: stalePid - 1, startedAt, nonce: 'other' })
  let swapped = false
  // Contender B replaces our recovery file after we wrote it, before we rename it.
  const env = {
    now: () => Date.now(),
    bootTime: () => 0,
    isAlive: () => {
      if (existsSync(recovery) && !swapped) {
        swapped = true
        writeFileSync(recovery, other)
      }
      return false
    },
  }
  expect(() => acquireHomeLock(home, env)).toThrow('recovering')
  expect(readFileSync(recovery, 'utf8')).toBe(other)
})
