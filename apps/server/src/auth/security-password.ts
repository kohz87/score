import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import {
  ORIGIN_FILE,
  PASSWORD_FILE,
  PasswordLockError,
  passwordDigest,
  publishPassword,
  STORED_PATTERN,
  writeCredentialFile,
  withPasswordLock,
} from './password-store.ts'

// The owner's security password guards pairing management (pair another device, renew, terminate), so a compromised
// paired browser can't invite others, keep itself alive or lock the owner out. Only a salted scrypt hash is stored,
// in $SCORE_HOME/security-password (0600); it is read on every check so `score password` on the host applies at once.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const KEY_LENGTH = 32
const FILE = PASSWORD_FILE
const StoredSchema = z.string().regex(STORED_PATTERN)
export const PasswordSchema = z.string().min(8).max(256)

const WINDOW_MS = 15 * 60 * 1000
// Per session, so one compromised browser can't lock the owner out by guessing wrong; the global cap still bounds a
// guess spread across several paired browsers.
const MAX_FAILURES_PER_SESSION = 5
const MAX_FAILURES = 20

export interface AttemptLimits {
  perSession: number
  overall: number
}
const DEFAULT_LIMITS: AttemptLimits = {
  perSession: MAX_FAILURES_PER_SESSION,
  overall: MAX_FAILURES,
}

function storeError(): HttpError {
  return new HttpError(
    503,
    'security_store_unavailable',
    'Can’t read the saved security password. Reset it on the Score machine with `scripts/score password`.',
  )
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(PasswordSchema.parse(password), salt, KEY_LENGTH, PARAMS)
  return `scrypt$15$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export const writePasswordFile = writeCredentialFile
export { passwordDigest }

export class SecurityPassword {
  #failures: { at: number; session: string }[] = []
  /** The stored hash the failures counted against: a new password (e.g. reset on the host) clears them. */
  #against: string | undefined
  constructor(
    private readonly home: string | undefined,
    private readonly clock: () => number = Date.now,
    /** Test seam: runs under the lock after the final comparison, right before the files are written. */
    private readonly beforePublish?: () => Promise<void>,
    /** Fake mode only (app.ts): the e2e suite repeats wrong guesses from one paired browser and must not lock itself out. */
    private readonly limits: AttemptLimits = DEFAULT_LIMITS,
  ) {}

  /**
   * The stored hash, `undefined` only when the file is absent (the intentional bootstrap state). Corrupt or unreadable
   * storage throws, so a damaged store can't be mistaken for "no password yet" and re-enrolled without the old one.
   */
  private stored(): string | undefined {
    if (!this.home) return undefined
    let raw: string
    try {
      raw = fs.readFileSync(join(this.home, FILE), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw storeError()
    }
    const parsed = StoredSchema.safeParse(raw.trim())
    if (!parsed.success) throw storeError()
    return parsed.data
  }

  isSet(): boolean {
    try {
      return this.stored() !== undefined
    } catch {
      return true // damaged: treated as set (closed); verify/set report the recovery message
    }
  }

  /** True only if the current password was set on the Score machine itself (`scripts/score password`). */
  hostIssued(): boolean {
    let stored: string | undefined
    try {
      stored = this.stored()
    } catch {
      return false
    }
    if (!stored || !this.home) return false
    try {
      return (
        fs.readFileSync(join(this.home, ORIGIN_FILE), 'utf8').trim() ===
        `host ${passwordDigest(stored)}`
      )
    } catch {
      return false
    }
  }

  /**
   * Throws unless `password` matches. Wrong guesses are limited per session (5 per 15 minutes) and overall (20), and
   * forgotten when the password changes.
   */
  async verify(password: unknown, session = ''): Promise<void> {
    const stored = this.stored()
    if (!stored)
      throw new HttpError(409, 'password_not_set', 'Set a security password in Settings first.')
    if (stored !== this.#against) {
      this.#failures = []
      this.#against = stored
    }
    const now = this.clock()
    this.#failures = this.#failures.filter((failure) => now - failure.at < WINDOW_MS)
    const mine = this.#failures.filter((failure) => failure.session === session).length
    if (mine >= this.limits.perSession || this.#failures.length >= this.limits.overall)
      throw new HttpError(
        429,
        'too_many_attempts',
        'Too many wrong passwords. Wait 15 minutes and try again.',
      )
    // Counted before the slow hash starts, so parallel guesses can't all pass the check; a match gives it back.
    const attempt = { at: now, session }
    this.#failures.push(attempt)
    const candidate = PasswordSchema.safeParse(password)
    const [, , , , salt, key] = stored.split('$')
    const expected = Buffer.from(key!, 'base64url')
    const actual = candidate.success
      ? await scrypt(candidate.data, Buffer.from(salt!, 'base64url'), KEY_LENGTH, PARAMS)
      : Buffer.alloc(KEY_LENGTH)
    if (!candidate.success || !timingSafeEqual(actual, expected)) {
      throw new HttpError(403, 'wrong_password', 'That isn’t the security password.')
    }
    // The credential may have been replaced (e.g. reset on the host) while the hash ran: a match against the old one
    // no longer proves anything.
    if (this.stored() !== stored)
      throw new HttpError(409, 'password_changed', 'The security password changed. Try again.')
    this.#failures = this.#failures.filter((failure) => failure !== attempt)
  }

  /** First time: no current password needed. After that, changing it needs the current one. */
  async set(password: unknown, current: unknown, session = ''): Promise<void> {
    if (!this.home)
      throw new HttpError(501, 'unsupported', 'Score has nowhere to store the password here.')
    const next = PasswordSchema.safeParse(password)
    if (!next.success)
      throw new HttpError(400, 'bad_request', 'Use 8–256 characters for the security password.')
    const before = this.stored()
    if (before !== undefined) await this.verify(current, session)
    const hashed = await hashPassword(next.data)
    // Compare-and-swap under the lock every writer takes (this server and `scripts/score password`, which is
    // another process): the stored credential is checked again once we hold it, so a competing change is rejected,
    // never overwritten unseen.
    try {
      await withPasswordLock(this.home, async () => {
        if (this.stored() !== before)
          throw new HttpError(409, 'password_changed', 'The security password changed. Try again.')
        await this.beforePublish?.()
        publishPassword(this.home!, hashed, 'browser')
      })
    } catch (error) {
      if (error instanceof PasswordLockError)
        throw new HttpError(
          409,
          'password_changed',
          'The security password is being changed. Try again.',
        )
      throw error
    }
  }
}
