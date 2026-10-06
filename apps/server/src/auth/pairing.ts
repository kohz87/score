import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import { readCookie, SESSION_COOKIE, SESSION_MAX_AGE } from './cookies.ts'
import { InMemorySessionStore, type SessionStore } from './session-store.ts'

export const PAIRING_TTL_MS = 15 * 60 * 1000
const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

export class PairingService {
  #tokenHash: Buffer | undefined
  #tokenExpiresAt = 0

  constructor(
    private readonly sessions: SessionStore = new InMemorySessionStore(),
    private readonly clock: () => number = Date.now,
  ) {}

  createToken(): string {
    const token = randomBytes(32).toString('base64url')
    this.#tokenHash = hashSecret(token)
    this.#tokenExpiresAt = this.clock() + PAIRING_TTL_MS
    return token
  }

  pair(token: string): string {
    const matches = timingSafeEqual(hashSecret(token), this.#tokenHash ?? Buffer.alloc(32))
    if (!this.#tokenHash || this.clock() >= this.#tokenExpiresAt || !matches) {
      throw new HttpError(401, 'pairing_failed', 'Pairing token is invalid or expired')
    }
    this.#tokenHash = undefined
    const id = randomBytes(32).toString('base64url')
    this.sessions.create(hashSecret(id).toString('hex'), this.clock() + SESSION_MAX_AGE * 1000)
    return id
  }

  isPaired(cookie: string | undefined): boolean {
    const hash = this.sessionHash(cookie)
    return hash !== undefined && this.sessions.has(hash, this.clock())
  }

  revoke(cookie: string | undefined): void {
    const hash = this.sessionHash(cookie)
    if (hash !== undefined) this.sessions.revoke(hash)
  }

  private sessionHash(cookie: string | undefined): string | undefined {
    const result = SessionIdSchema.safeParse(readCookie(cookie, SESSION_COOKIE))
    return result.success ? hashSecret(result.data).toString('hex') : undefined
  }
}
