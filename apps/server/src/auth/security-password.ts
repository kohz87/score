import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { HttpError } from '../errors.ts'

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
const FILE = 'security-password'
const StoredSchema = z.string().regex(/^scrypt\$15\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
export const PasswordSchema = z.string().min(8).max(256)

const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 5

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(PasswordSchema.parse(password), salt, KEY_LENGTH, PARAMS)
  return `scrypt$15$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export function writePasswordFile(home: string, stored: string): void {
  const path = join(home, FILE)
  const temp = `${path}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${StoredSchema.parse(stored)}\n`, { mode: 0o600, flag: 'wx' })
  fs.renameSync(temp, path)
}

export class SecurityPassword {
  #failures: number[] = []
  constructor(
    private readonly home: string | undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  private stored(): string | undefined {
    if (!this.home) return undefined
    try {
      const parsed = StoredSchema.safeParse(fs.readFileSync(join(this.home, FILE), 'utf8').trim())
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  isSet(): boolean {
    return this.stored() !== undefined
  }

  /** Throws unless `password` matches. Failures are rate-limited across all sessions (5 per 15 minutes). */
  async verify(password: unknown): Promise<void> {
    const stored = this.stored()
    if (!stored)
      throw new HttpError(409, 'password_not_set', 'Set a security password in Settings first')
    const now = this.clock()
    this.#failures = this.#failures.filter((at) => now - at < WINDOW_MS)
    if (this.#failures.length >= MAX_FAILURES)
      throw new HttpError(429, 'too_many_attempts', 'Too many wrong passwords. Try again later.')
    const candidate = PasswordSchema.safeParse(password)
    const [, , , , salt, key] = stored.split('$')
    const expected = Buffer.from(key!, 'base64url')
    const actual = candidate.success
      ? await scrypt(candidate.data, Buffer.from(salt!, 'base64url'), KEY_LENGTH, PARAMS)
      : Buffer.alloc(KEY_LENGTH)
    if (!candidate.success || !timingSafeEqual(actual, expected)) {
      this.#failures.push(now)
      throw new HttpError(403, 'wrong_password', 'That is not the security password')
    }
  }

  /** First time: no current password needed. After that, changing it needs the current one. */
  async set(password: unknown, current: unknown): Promise<void> {
    if (!this.home) throw new HttpError(501, 'unsupported', 'No Score home to store the password')
    const next = PasswordSchema.safeParse(password)
    if (!next.success)
      throw new HttpError(400, 'bad_request', 'Use 8 to 256 characters for the security password')
    if (this.isSet()) await this.verify(current)
    writePasswordFile(this.home, await hashPassword(next.data))
  }
}
