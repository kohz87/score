import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { registerKnownSecret } from '../redact.ts'
import { HttpError } from '../errors.ts'
import { readCookie, SESSION_COOKIE, SESSION_MAX_AGE } from './cookies.ts'
import { InMemorySessionStore, type SessionStore } from './session-store.ts'

export const PAIRING_TTL_MS = 15 * 60 * 1000
const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000
export const SESSION_ABSOLUTE_MS = SESSION_MAX_AGE * 1000

type Attempt = { count: number; until: number; window: number }

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

export class PairingService {
  #tokenHash: Buffer | undefined
  #tokenExpiresAt = 0
  readonly #attempts = new Map<string, Attempt>()
  #global: Attempt = { count: 0, until: 0, window: 0 }
  readonly #streams = new Map<string, Set<() => void>>()
  readonly #timers = new Map<string, NodeJS.Timeout>()
  /** When each session's cookie lifetime was last re-sent (in memory: a restart just re-sends once). */
  readonly #cookieSentAt = new Map<string, number>()
  readonly #freshAuthAt = new Map<string, number>()
  /** 3.14.2: Settings › Remote access and security is unlocked for this session until then (in memory, sliding). */
  readonly #unlockedUntil = new Map<string, number>()
  readonly #revoked = new Map<string, Set<() => void>>()

  constructor(
    private readonly sessions: SessionStore = new InMemorySessionStore(),
    private readonly clock: () => number = Date.now,
    readonly remote = false,
  ) {}

  createToken(): string {
    const token = randomBytes(32).toString('base64url')
    registerKnownSecret(token)
    this.#tokenHash = hashSecret(token)
    this.#tokenExpiresAt = this.clock() + PAIRING_TTL_MS
    return token
  }

  pair(token: string, peer = '', label = 'Browser'): string {
    if (this.remote) this.limitAttempts(peer)
    const matches = timingSafeEqual(hashSecret(token), this.#tokenHash ?? Buffer.alloc(32))
    if (!this.#tokenHash || this.clock() >= this.#tokenExpiresAt || !matches) {
      throw new HttpError(
        401,
        'pairing_failed',
        'This pairing link is invalid or has expired. Get a new one in the server terminal.',
      )
    }
    this.#tokenHash = undefined
    return this.createSession(peer, label)
  }

  /** Counts one sign-in attempt against the pairing rate limits (remote mode only, like `pair`). */
  limitSignIn(peer: string): void {
    if (this.remote) this.limitAttempts(peer)
  }

  /**
   * A new paired-browser session with the same cookie id, limits and expiry as a pairing link. Callers have already
   * proven who is asking (a pairing token, a passkey assertion).
   */
  createSession(peer = '', label = 'Browser'): string {
    const id = randomBytes(32).toString('base64url')
    const hash = hashSecret(id).toString('hex')
    if (this.remote) {
      this.sessions.createRemote({
        hash,
        id: randomUUID(),
        label: label.slice(0, 200),
        address: peer.slice(0, 100),
        createdAt: this.clock(),
        lastSeenAt: this.clock(),
        expiresAt: this.clock() + SESSION_ABSOLUTE_MS,
      })
    } else this.sessions.create(hash, this.clock() + SESSION_MAX_AGE * 1000)
    return id
  }

  isPaired(cookie: string | undefined): boolean {
    const hash = this.sessionHash(cookie)
    return hash !== undefined && this.isHashPaired(hash)
  }

  /** `isPaired` for a session already named by its hash (sessionKey in http/session.ts); long-lived holders re-check it. */
  isHashPaired(hash: string): boolean {
    if (!this.remote) return this.sessions.has(hash, this.clock())
    const session = this.sessions.getRemote(hash)
    if (session && this.clock() < Math.min(session.expiresAt, session.lastSeenAt + SESSION_IDLE_MS))
      return true
    this.revokeHash(hash)
    return false
  }

  /** The session hash for a cookie that is paired right now (the terminal binds tickets and processes to it). */
  pairedSession(cookie: string | undefined): string | undefined {
    const hash = this.sessionHash(cookie)
    return hash !== undefined && this.isHashPaired(hash) ? hash : undefined
  }

  /**
   * Records that this session just proved the security password or a passkey (server side: a cookie alone can't set
   * it). In memory on purpose: a restart asks again, and it only ever gates short-lived tickets.
   */
  markFresh(cookie: string | undefined): void {
    const hash = this.pairedSession(cookie)
    if (hash !== undefined) this.#freshAuthAt.set(hash, this.clock())
  }

  /**
   * 3.14.2 (owner): unlocks Remote access and security for this paired session for `ttlMs` after a correct security
   * password. In memory on purpose, like the fresh check: a restart, a sign-out or a revoke locks it again.
   */
  unlock(cookie: string | undefined, ttlMs: number): number | undefined {
    const hash = this.pairedSession(cookie)
    if (hash === undefined) return undefined
    const until = this.clock() + ttlMs
    this.#unlockedUntil.set(hash, until)
    return until
  }

  /** When this session's unlock ends, or null when it is locked (an ended unlock is forgotten). */
  unlockedUntil(cookie: string | undefined): number | null {
    const hash = this.pairedSession(cookie)
    if (hash === undefined) return null
    const until = this.#unlockedUntil.get(hash)
    if (until === undefined) return null
    if (until <= this.clock()) {
      this.#unlockedUntil.delete(hash)
      return null
    }
    return until
  }

  /** True while unlocked, and then pushes the end out by `ttlMs` (each use keeps it open). */
  touchUnlock(cookie: string | undefined, ttlMs: number): boolean {
    if (this.unlockedUntil(cookie) === null) return false
    return this.unlock(cookie, ttlMs) !== undefined
  }

  lock(cookie: string | undefined): void {
    const hash = this.sessionHash(cookie)
    if (hash !== undefined) this.#unlockedUntil.delete(hash)
  }

  /**
   * True if this session proved the password or a passkey no more than `maxAgeMs` ago, and uses that proof up: one
   * second-factor check opens one terminal.
   */
  takeFresh(hash: string, maxAgeMs: number): boolean {
    const at = this.#freshAuthAt.get(hash)
    this.#freshAuthAt.delete(hash)
    return at !== undefined && this.clock() - at <= maxAgeMs
  }

  /** Calls `callback` once when this session is revoked or expires (revoke, sign out, terminate). */
  onRevoked(hash: string, callback: () => void): () => void {
    const listeners = this.#revoked.get(hash) ?? new Set<() => void>()
    listeners.add(callback)
    this.#revoked.set(hash, listeners)
    return () => {
      listeners.delete(callback)
      if (!listeners.size) this.#revoked.delete(hash)
    }
  }

  /** The token's expiry, for a link minted from a paired browser ("Pair another device"). */
  tokenExpiresAt(): number {
    return this.#tokenExpiresAt
  }

  /** Gives one paired browser a fresh lifetime (Settings › Remote access › Renew). Remote mode only. */
  renewBrowser(id: string) {
    if (!this.remote)
      throw new HttpError(404, 'not_found', 'That paired browser is no longer listed.')
    const session = this.sessions.listRemote().find((candidate) => candidate.id === id)
    if (
      !session ||
      this.clock() >= Math.min(session.expiresAt, session.lastSeenAt + SESSION_IDLE_MS)
    )
      throw new HttpError(404, 'not_found', 'That paired browser is no longer listed.')
    this.sessions.renewRemote(session.hash, this.clock(), this.clock() + SESSION_ABSOLUTE_MS)
    // That browser's cookie still has its old Max-Age: re-send it on its next request.
    this.#cookieSentAt.delete(session.hash)
    this.scheduleExpiry(session.hash)
    return this.browsers(undefined).find((browser) => browser.id === id)!
  }

  /**
   * Seconds left on this browser's session when its cookie should be re-sent (at most hourly, or right after a
   * renewal), so the cookie never expires before the server-side session does. Undefined otherwise.
   */
  cookieRefresh(cookie: string | undefined): number | undefined {
    if (!this.remote) return undefined
    const hash = this.sessionHash(cookie)
    const session = hash === undefined ? undefined : this.sessions.getRemote(hash)
    if (!hash || !session) return undefined
    const sent = this.#cookieSentAt.get(hash)
    if (sent !== undefined && this.clock() - sent < 60 * 60 * 1000) return undefined
    this.#cookieSentAt.set(hash, this.clock())
    return Math.max(0, Math.floor((session.expiresAt - this.clock()) / 1000))
  }

  touch(cookie: string | undefined, address: string): void {
    if (!this.remote || !this.isPaired(cookie)) return
    const hash = this.sessionHash(cookie)!
    this.sessions.touchRemote(hash, this.clock(), address.slice(0, 100))
    this.scheduleExpiry(hash)
  }

  browsers(cookie: string | undefined) {
    const current = this.sessionHash(cookie)
    return this.sessions.listRemote().flatMap((session) => {
      if (this.clock() >= Math.min(session.expiresAt, session.lastSeenAt + SESSION_IDLE_MS)) {
        this.revokeHash(session.hash)
        return []
      }
      return [
        {
          id: session.id,
          label: session.label,
          address: session.address,
          createdAt: new Date(session.createdAt).toISOString(),
          lastSeenAt: new Date(session.lastSeenAt).toISOString(),
          expiresAt: new Date(
            Math.min(session.expiresAt, session.lastSeenAt + SESSION_IDLE_MS),
          ).toISOString(),
          current: session.hash === current,
        },
      ]
    })
  }

  /** Terminates every paired browser except the caller's; returns how many. */
  revokeOthers(cookie: string | undefined): number {
    const current = this.sessionHash(cookie)
    const others = this.sessions.listRemote().filter((session) => session.hash !== current)
    for (const session of others) this.revokeHash(session.hash)
    return others.length
  }

  revokeBrowser(id: string): void {
    const session = this.sessions.listRemote().find((session) => session.id === id)
    if (session) this.revokeHash(session.hash)
  }

  watch(cookie: string | undefined, close: () => void): () => void {
    if (!this.remote) return () => {}
    const hash = this.sessionHash(cookie)
    if (!hash || !this.isPaired(cookie)) {
      close()
      return () => {}
    }
    const streams = this.#streams.get(hash) ?? new Set<() => void>()
    streams.add(close)
    this.#streams.set(hash, streams)
    this.scheduleExpiry(hash)
    return () => {
      streams.delete(close)
      if (!streams.size) {
        this.#streams.delete(hash)
        clearTimeout(this.#timers.get(hash))
        this.#timers.delete(hash)
      }
    }
  }

  close(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer)
    for (const streams of this.#streams.values()) for (const close of streams) close()
    this.#streams.clear()
    this.#timers.clear()
  }

  revoke(cookie: string | undefined): void {
    const hash = this.sessionHash(cookie)
    if (hash !== undefined) this.revokeHash(hash)
  }

  private revokeHash(hash: string): void {
    this.#cookieSentAt.delete(hash)
    this.#freshAuthAt.delete(hash)
    this.#unlockedUntil.delete(hash)
    const listeners = this.#revoked.get(hash)
    this.#revoked.delete(hash)
    if (listeners) for (const callback of listeners) callback()
    if (this.remote) this.sessions.revokeRemote(hash)
    else this.sessions.revoke(hash)
    clearTimeout(this.#timers.get(hash))
    this.#timers.delete(hash)
    const streams = this.#streams.get(hash)
    this.#streams.delete(hash)
    if (streams) for (const close of streams) close()
  }

  private scheduleExpiry(hash: string): void {
    clearTimeout(this.#timers.get(hash))
    if (!this.#streams.has(hash)) return
    const session = this.sessions.getRemote(hash)
    if (!session) {
      this.revokeHash(hash)
      return
    }
    const remaining =
      Math.min(session.expiresAt, session.lastSeenAt + SESSION_IDLE_MS) - this.clock()
    if (remaining <= 0) {
      this.revokeHash(hash)
      return
    }
    const timer = setTimeout(() => this.scheduleExpiry(hash), Math.min(remaining, 2_147_483_647))
    timer.unref()
    this.#timers.set(hash, timer)
  }

  private limitAttempts(peer: string): void {
    const now = this.clock()
    for (const [key, value] of this.#attempts)
      if (now >= value.window + 60_000) this.#attempts.delete(key)
    if (now >= this.#global.window + 60_000) this.#global = { count: 0, until: 0, window: now }
    let attempt = this.#attempts.get(peer)
    if (!attempt) {
      if (this.#attempts.size >= 1024)
        throw new HttpError(
          429,
          'pairing_limited',
          'Too many pairing attempts. Wait a minute and try again.',
        )
      attempt = { count: 0, until: 0, window: now }
      this.#attempts.set(peer, attempt)
    }
    if (this.#global.count >= 60 || now < attempt.until)
      throw new HttpError(
        429,
        'pairing_limited',
        'Too many pairing attempts. Wait a minute and try again.',
      )
    this.#global.count++
    attempt.count++
    if (attempt.count >= 5)
      attempt.until = now + Math.min(60_000, 250 * 2 ** Math.min(attempt.count - 5, 8))
  }

  private sessionHash(cookie: string | undefined): string | undefined {
    const result = SessionIdSchema.safeParse(readCookie(cookie, SESSION_COOKIE))
    return result.success ? hashSecret(result.data).toString('hex') : undefined
  }
}
