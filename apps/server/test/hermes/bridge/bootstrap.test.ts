import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { hashBridgeToken, loadBridgeBootstrap } from '../../../src/hermes/bridge/bootstrap.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'score-bridge-bootstrap-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

test('bootstrap exclusively creates 32 random bytes in an owner-only file and reuses them', () => {
  const hash = loadBridgeBootstrap(home)
  const token = readFileSync(join(home, 'bridge.token'), 'utf8')
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(Buffer.from(token, 'base64url')).toHaveLength(32)
  expect(statSync(join(home, 'bridge.token')).mode & 0o777).toBe(0o600)
  expect(hash).toEqual(hashBridgeToken(token))
  expect(loadBridgeBootstrap(home)).toEqual(hash)
  expect(readFileSync(join(home, 'bridge.token'), 'utf8')).toBe(token)
})

test.each([0o640, 0o604, 0o660, 0o644])(
  'bootstrap refuses existing mode %s without changing it',
  (mode) => {
    loadBridgeBootstrap(home)
    const path = join(home, 'bridge.token')
    chmodSync(path, mode)
    expect(() => loadBridgeBootstrap(home)).toThrow('owner-only')
    expect(statSync(path).mode & 0o777).toBe(mode)
  },
)

test('bootstrap refuses symlinks and invalid content without echoing it', () => {
  const target = join(home, 'other')
  writeFileSync(target, 'invalid-secret-content', { mode: 0o600 })
  symlinkSync(target, join(home, 'bridge.token'))
  expect(() => loadBridgeBootstrap(home)).toThrow()
  rmSync(join(home, 'bridge.token'))
  writeFileSync(join(home, 'bridge.token'), 'invalid-secret-content', { mode: 0o600 })
  expect(() => loadBridgeBootstrap(home)).toThrow('Bridge bootstrap token has an invalid format')
})

test('bootstrap creation leaves no temporary files and a concurrent token wins', () => {
  const home = mkdtempSync(join(tmpdir(), 'score-bootstrap-race-'))
  writeFileSync(join(home, 'bridge.token'), 'a'.repeat(43), { mode: 0o600 })
  expect(loadBridgeBootstrap(home)).toEqual(hashBridgeToken('a'.repeat(43)))
  expect(readdirSync(home)).toEqual(['bridge.token'])
})

test('bootstrap rejects a FIFO without waiting for a writer', (context) => {
  const path = join(home, 'bridge.token')
  try {
    execFileSync('mkfifo', [path])
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      ['ENOENT', 'EPERM', 'EACCES'].includes(String(error.code))
    ) {
      context.skip()
      return
    }
    throw error
  }
  chmodSync(path, 0o600)
  expect(() => loadBridgeBootstrap(home)).toThrow('owner-only regular file')
})
