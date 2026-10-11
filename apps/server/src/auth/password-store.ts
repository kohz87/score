// The security password's files and the one lock every writer takes, shared by the server's setter and
// `scripts/set-password.mjs` (the host command), which runs as a separate process. Node built-ins only, and only
// syntax Node can strip, so the script can import this file as it is.
import { createHash, randomBytes, scryptSync } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'

export const PASSWORD_FILE = 'security-password'
// Who set the current password: `host <sha256 of the stored line>` (the digest ties the mark to that exact hash) or
// `browser`. The terminal trusts only a password the host issued, so a stolen cookie can't enrol its own.
export const ORIGIN_FILE = 'security-password.origin'
const LOCK_FILE = 'security-password.lock'
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
const LOCK_POLL_MS = 25
// A lock file that doesn't name a process (an interrupted write of the lock itself) is stale after this long.
const LOCK_UNREADABLE_MS = 5_000

export class PasswordLockError extends Error {
  readonly code = 'ELOCKED'
  constructor() {
    super('The security password is being changed by another process.')
  }
}

/** /proc/<pid>/stat field 22: the start time, which with the pid names one process for good. null without /proc. */
function startTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return (
      stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(' ')[19] ?? null
    )
  } catch {
    return null
  }
}

function holderAlive(content: string): boolean | null {
  const match = /^(\d+) (\S+)\n?$/.exec(content)
  if (!match) return null // unreadable lock content
  const pid = Number(match[1])
  const started = match[2]!
  const now = startTime(pid)
  if (now !== null) return started === 'unknown' ? true : now === started
  // No /proc: fall back to "does the pid exist".
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function tryAcquire(path: string, token: string): boolean {
  try {
    const fd = fs.openSync(path, 'wx', 0o600)
    try {
      fs.writeSync(fd, token)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/** Removes the lock at `path` only if it still holds the content we judged stale. */
function breakStale(path: string, judged: string): void {
  const parked = `${path}.stale.${process.pid}.${randomBytes(4).toString('hex')}`
  try {
    fs.renameSync(path, parked) // atomic: of several breakers, one moves the file
  } catch {
    return
  }
  let moved = ''
  try {
    moved = fs.readFileSync(parked, 'utf8')
  } catch {
    // keep going: nothing to compare
  }
  if (moved === judged) {
    fs.rmSync(parked, { force: true })
    return
  }
  // We moved a lock somebody took after our check: put it back without replacing anything new.
  try {
    fs.linkSync(parked, path)
  } catch {
    // A newer lock already exists; the parked one is a stale leftover of a holder that will see it gone.
  }
  fs.rmSync(parked, { force: true })
}

/**
 * Runs `fn` while holding the exclusive password lock (`security-password.lock` in the Score folder, holding the
 * owner's pid and process start time). A lock whose owner is gone is recovered. The lock is released afterwards, also
 * on error. Throws PasswordLockError when it can't be had in about ten seconds.
 */
export async function withPasswordLock<T>(
  home: string,
  fn: () => T | Promise<T>,
  waitMs = LOCK_WAIT_MS,
): Promise<T> {
  const path = join(home, LOCK_FILE)
  const token = `${process.pid} ${startTime(process.pid) ?? 'unknown'}\n`
  const deadline = Date.now() + waitMs
  while (!tryAcquire(path, token)) {
    let content: string | undefined
    let age: number
    try {
      content = fs.readFileSync(path, 'utf8')
      age = Date.now() - fs.statSync(path).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue // released in between: take it
      // A lock we can't read (another user's, e.g. a host command run with sudo) is never ours to break: wait, then
      // give up, instead of spinning without yielding.
      if (Date.now() >= deadline) throw new PasswordLockError()
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
      continue
    }
    const alive = holderAlive(content)
    if (alive === false || (alive === null && age > LOCK_UNREADABLE_MS)) breakStale(path, content)
    else {
      if (Date.now() >= deadline) throw new PasswordLockError()
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
    }
  }
  try {
    return await fn()
  } finally {
    // Ours unless something broke it meanwhile; never delete a lock another process now owns.
    try {
      if (fs.readFileSync(path, 'utf8') === token) fs.rmSync(path, { force: true })
    } catch {
      // already gone
    }
  }
}
