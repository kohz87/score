import { createHash, randomBytes } from 'node:crypto'
import { registerKnownSecret } from '../redact.ts'

export const TICKET_TTL_MS = 60_000
/** How recent the password or passkey check must be to mint a ticket. */
export const FRESH_AUTH_MS = 60_000
const MAX_OUTSTANDING = 16

interface Entry {
  session: string
  origin: string
  expiresAt: number
  /** 3.11.0: the agent whose CLI the terminal runs (absent: a login shell). */
  agent?: string
}

/**
 * One-time terminal tickets (PLAN 7.3). The browser can't send headers on a WebSocket upgrade, so the ticket rides in
 * the URL: it is random, lives 60 s, is bound to the paired session and the page origin that minted it, opens exactly
 * one terminal, and only its hash is kept (in memory: a restart voids every ticket).
 */
export class TerminalTickets {
  readonly #entries = new Map<string, Entry>()
  constructor(private readonly clock: () => number = Date.now) {}

  mint(
    session: string,
    origin: string,
    agent?: string,
  ): { ticket: string; expiresAt: number } | undefined {
    this.prune()
    if (this.#entries.size >= MAX_OUTSTANDING) return undefined
    const ticket = randomBytes(32).toString('base64url')
    // Belt and braces for the logs: even a path that forgets the URL rules replaces this exact value.
    registerKnownSecret(ticket)
    const expiresAt = this.clock() + TICKET_TTL_MS
    this.#entries.set(hash(ticket), { session, origin, expiresAt, ...(agent ? { agent } : {}) })
    return { ticket, expiresAt }
  }

  /**
   * Burns the ticket whether or not it fits (a wrong session or origin must not get a second try). What it opens: a
   * login shell (`{}`) or an agent's CLI (`{ agent }`); undefined when it doesn't fit.
   */
  redeem(ticket: string, session: string, origin: string): { agent?: string } | undefined {
    const key = hash(ticket)
    const entry = this.#entries.get(key)
    this.#entries.delete(key)
    if (
      entry === undefined ||
      this.clock() >= entry.expiresAt ||
      entry.session !== session ||
      entry.origin !== origin
    )
      return undefined
    return entry.agent ? { agent: entry.agent } : {}
  }

  /** Void the tickets of a session that ended. */
  dropSession(session: string): void {
    for (const [key, entry] of this.#entries)
      if (entry.session === session) this.#entries.delete(key)
  }

  private prune(): void {
    const now = this.clock()
    for (const [key, entry] of this.#entries) if (now >= entry.expiresAt) this.#entries.delete(key)
  }
}

function hash(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex')
}
