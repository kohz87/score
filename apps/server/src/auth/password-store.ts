// The security password's files and the one lock every writer takes, shared by the server's setter and
// `scripts/set-password.mjs` (the host command), which runs as a separate process. Node built-ins only, and only
// syntax Node can strip, so the script can import this file as it is.
import { createHash, randomBytes, scryptSync } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { OsLockTimeoutError, sharedOsLock } from '../locks/os-lock.ts'

export const PASSWORD_FILE = 'security-password'
// Who set the current password: `host <sha256 of the stored line>` (the digest ties the mark to that exact hash) or
// `browser`. The terminal trusts only a password the host issued, so a stolen cookie can't enrol its own.
export const ORIGIN_FILE = 'security-password.origin'
export const STORED_PATTERN = /^scrypt\$15\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export const KEY_LENGTH = 32

export function passwordDigest(stored: string): string {
  return createHash('sha256').update(stored).digest('hex')
}

/** Salted scrypt line in the stored format (the host command's synchronous variant). */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS)
  return `scrypt$15$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`
}

function writeAtomic(path: string, content: string): void {
  // Unique per call: a failed earlier replacement (or a concurrent one) must not leave a name that blocks this one.
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, path)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

export function writeCredentialFile(home: string, stored: string): void {
  if (!STORED_PATTERN.test(stored)) throw new Error('Not a stored security password.')
  writeAtomic(join(home, PASSWORD_FILE), `${stored}\n`)
}

/**
 * Publishes a new password with its provenance. Two files, so the order is the protocol: the provenance first, then
 * the credential. `host <digest>` names one exact hash, so a crash between the two (old credential, new provenance)
 * reads as "not host-issued" and fails closed, and `browser` over an old credential only loses host status. Callers
 * hold the lock (`withPasswordLock`).
 */
export function publishPassword(home: string, stored: string, origin: 'host' | 'browser'): void {
  if (!STORED_PATTERN.test(stored)) throw new Error('Not a stored security password.')
  writeAtomic(
    join(home, ORIGIN_FILE),
    origin === 'host' ? `host ${passwordDigest(stored)}\n` : 'browser\n',
  )
  writeCredentialFile(home, stored)
}

/** The host command: hash, then publish under the lock. */
export async function applyHostPassword(home: string, password: string): Promise<string> {
  const stored = hashPasswordSync(password)
  await withPasswordLock(home, () => publishPassword(home, stored, 'host'))
  return join(home, PASSWORD_FILE)
}

// ---- inter-process lock -------------------------------------------------------------------------------------------

const LOCK_WAIT_MS = 10_000

export class PasswordLockError extends Error {
  readonly code = 'ELOCKED'
  constructor() {
    super('The security password is being changed by another process.')
  }
}

/**
 * Runs `fn` while holding the exclusive password lock: an OS lock on `lock.sqlite` in the Score folder (see
 * `locks/os-lock.ts`). The kernel releases it if the holder dies, so nothing is ever recovered or stolen. Throws
 * PasswordLockError when it can't be had within `waitMs` (about ten seconds).
 */
export async function withPasswordLock<T>(
  home: string,
  fn: () => T | Promise<T>,
  waitMs = LOCK_WAIT_MS,
): Promise<T> {
  try {
    return await sharedOsLock(home).run(fn, waitMs)
  } catch (error) {
    if (error instanceof OsLockTimeoutError) throw new PasswordLockError()
    throw error
  }
}
