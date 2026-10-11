import { isIP } from 'node:net'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'

// Passkeys sign a browser in like a pairing link does (security design 2026-10-09, task 5.28). Everything here is
// strict on purpose: user verification is always required, challenges are single-use and short-lived, and a
// sign-count regression refuses the credential and flags it.
export const CHALLENGE_TTL_MS = 5 * 60 * 1000
const MAX_CHALLENGES = 1024
const MAX_CHALLENGES_PER_PEER = 8
const ES256 = -7
const RS256 = -257

const RowSchema = z.object({
  id: z.string(),
  rp_id: z.string(),
  public_key: z.instanceof(Uint8Array),
  counter: z.number().int(),
  transports: z.string(),
  label: z.string(),
  created_at: z.number().int(),
  last_used_at: z.number().int().nullable(),
  flagged_at: z.number().int().nullable(),
})
type Row = z.infer<typeof RowSchema>
const TransportsSchema = z.array(z.string().max(32)).max(8)

export interface PasskeyInfo {
  id: string
  label: string
  createdAt: string
  lastUsedAt: string | null
  flagged: boolean
}

interface Challenge {
  kind: 'register' | 'authenticate'
  rpId: string
  origin: string
  expiresAt: number
  /** Registration: the paired session that asked (and proved the security password). Authentication: the peer. */
  owner: string
  /** Registration only: the credential label the person chose. */
  label?: string
}

/**
 * The RP ID a passkey would get on this origin: its host name. Passkeys need a domain, so IP addresses (the LAN
 * address) are refused; `localhost` works. Null when the origin cannot use passkeys.
 */
export function rpIdForOrigin(origin: string | undefined): string | null {
  if (!origin) return null
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return null
  }
  const host = url.hostname
  if (url.protocol !== 'https:' && host !== 'localhost') return null
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 || (!host.includes('.') && host !== 'localhost'))
    return null
  return host
}

function fail(): never {
  throw new HttpError(401, 'passkey_failed', 'Passkey sign-in failed')
}

export class PasskeyService {
  readonly #challenges = new Map<string, Challenge>()

  constructor(
    private readonly db: ScoreDb,
    private readonly clock: () => number = Date.now,
    /** Origins the browser may be on (the CSRF guard's list); a passkey ceremony from anywhere else is refused. */
    private readonly allowedOrigins: ReadonlySet<string> = new Set(),
  ) {}

  private rows(): Row[] {
    return this.db.sqlite
      .prepare('SELECT * FROM passkeys ORDER BY created_at')
      .all()
      .map((row) => RowSchema.parse(row))
  }

  private row(id: string): Row | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM passkeys WHERE id = ?').get(id)
    return row === undefined ? undefined : RowSchema.parse(row)
  }

  list(): PasskeyInfo[] {
    return this.rows().map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
      flagged: row.flagged_at !== null,
    }))
  }

  /** Removing every passkey is fine: pairing links keep working. */
  remove(id: string): void {
    this.db.sqlite.prepare('DELETE FROM passkeys WHERE id = ?').run(id)
  }

  /** Whether a browser on `origin` can use passkeys, and under which RP ID (null when it can't). */
  availability(origin: string): { available: boolean; rpId: string | null } {
    const rpId = rpIdForOrigin(origin)
    return rpId && this.allowedOrigins.has(origin)
      ? { available: true, rpId }
      : { available: false, rpId: null }
  }

  /** The RP ID for a request's origin, or throws when passkeys can't be used from it. */
  private ceremonyOrigin(origin: string | undefined): { origin: string; rpId: string } {
    const rpId = rpIdForOrigin(origin)
    if (!origin || !rpId || !this.allowedOrigins.has(origin))
      throw new HttpError(
        409,
        'passkeys_unavailable',
        'Passkeys need a domain name (such as the Tailscale address), not an IP address',
      )
    return { origin, rpId }
  }

  private issue(challenge: string, value: Challenge): void {
    const now = this.clock()
    for (const [key, entry] of this.#challenges)
      if (entry.expiresAt <= now) this.#challenges.delete(key)
    // A peer asking for options over and over only evicts its own earlier ones; the global cap drops the oldest.
    const mine = [...this.#challenges].filter(([, entry]) => entry.owner === value.owner)
    while (mine.length >= MAX_CHALLENGES_PER_PEER) this.#challenges.delete(mine.shift()![0])
    // The global cap drops the oldest of the same kind, so sign-in options spam can't evict a pending registration.
    const same = [...this.#challenges].filter(([, entry]) => entry.kind === value.kind)
    while (this.#challenges.size >= MAX_CHALLENGES && same.length)
      this.#challenges.delete(same.shift()![0])
    this.#challenges.set(challenge, value)
  }

  /** Single use: gone after the first look, whether or not the response then verifies. */
  private take(
    clientDataJSON: string,
    kind: Challenge['kind'],
    owner: string,
  ): { challenge: string; entry: Challenge } {
    let challenge: string
    try {
      challenge = decodeClientDataJSON(clientDataJSON).challenge
    } catch {
      return fail()
    }
    const entry = this.#challenges.get(challenge)
    this.#challenges.delete(challenge)
    if (!entry || entry.kind !== kind || entry.owner !== owner || this.clock() >= entry.expiresAt)
      return fail()
    return { challenge, entry }
  }

  async registrationOptions(input: { origin: string | undefined; session: string; label: string }) {
    const { origin, rpId } = this.ceremonyOrigin(input.origin)
    const options = await generateRegistrationOptions({
      rpName: 'Score',
      rpID: rpId,
      userName: 'score',
      userDisplayName: input.label,
      // A fresh handle per passkey: a shared one would make a device replace its earlier Score passkey.
      attestationType: 'none',
      excludeCredentials: this.rows()
        .filter((row) => row.rp_id === rpId)
        .map((row) => ({
          id: row.id,
          transports: TransportsSchema.catch([]).parse(JSON.parse(row.transports)),
        })),
      // Discoverable credentials only: new passkeys must be findable by the browser even without a descriptor list.
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      supportedAlgorithmIDs: [ES256, RS256],
    })
    this.issue(options.challenge, {
      kind: 'register',
      rpId,
      origin,
      expiresAt: this.clock() + CHALLENGE_TTL_MS,
      owner: input.session,
      label: input.label,
    })
    return options
  }

  async register(input: {
    origin: string | undefined
    session: string
    response: unknown
  }): Promise<PasskeyInfo> {
    const response = z
      .object({ id: z.string(), response: z.object({ clientDataJSON: z.string() }).loose() })
      .loose()
      .safeParse(input.response)
    if (!response.success) throw new HttpError(400, 'bad_request', 'Invalid request')
    const { challenge, entry } = this.take(
      response.data.response.clientDataJSON,
      'register',
      input.session,
    )
    // The ceremony must finish on the origin it started on.
    if (input.origin !== entry.origin) return fail()
    let verified
    try {
      verified = await verifyRegistrationResponse({
        // zod only checked the parts we read; the library validates the rest of the WebAuthn structure.
        response: input.response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
        expectedChallenge: challenge,
        expectedOrigin: entry.origin,
        expectedRPID: entry.rpId,
        requireUserVerification: true,
      })
    } catch {
      return fail()
    }
    if (!verified.verified) return fail()
    const { credential } = verified.registrationInfo
    if (this.row(credential.id))
      throw new HttpError(409, 'conflict', 'That passkey is already registered')
    const now = this.clock()
    const label = entry.label ?? 'Passkey'
    this.db.sqlite
      .prepare(
        'INSERT INTO passkeys (id, rp_id, public_key, counter, transports, label, created_at, last_used_at, flagged_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
      )
      .run(
        credential.id,
        entry.rpId,
        credential.publicKey,
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        label,
        now,
      )
    return {
      id: credential.id,
      label,
      createdAt: new Date(now).toISOString(),
      lastUsedAt: null,
      flagged: false,
    }
  }

  async authenticationOptions(input: { origin: string | undefined; peer: string }) {
    const { origin, rpId } = this.ceremonyOrigin(input.origin)
    // The enrolled descriptors are offered too, so passkeys enrolled earlier as non-discoverable still work.
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials: this.rows()
        .filter((row) => row.rp_id === rpId)
        .map((row) => ({
          id: row.id,
          transports: TransportsSchema.catch([]).parse(JSON.parse(row.transports)),
        })),
      userVerification: 'required',
    })
    this.issue(options.challenge, {
      kind: 'authenticate',
      rpId,
      origin,
      expiresAt: this.clock() + CHALLENGE_TTL_MS,
      owner: input.peer,
    })
    return options
  }

  /** Verifies an assertion; the caller then creates the session. Throws 401 `passkey_failed` for every refusal. */
  async authenticate(input: {
    origin: string | undefined
    peer: string
    response: unknown
  }): Promise<PasskeyInfo> {
    const response = z
      .object({ id: z.string(), response: z.object({ clientDataJSON: z.string() }).loose() })
      .loose()
      .safeParse(input.response)
    if (!response.success) throw new HttpError(400, 'bad_request', 'Invalid request')
    const { challenge, entry } = this.take(
      response.data.response.clientDataJSON,
      'authenticate',
      input.peer,
    )
    if (input.origin !== entry.origin) return fail()
    const row = this.row(response.data.id)
    if (!row || row.rp_id !== entry.rpId || row.flagged_at !== null) return fail()
    let verified
    try {
      verified = await verifyAuthenticationResponse({
        response: input.response as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
        expectedChallenge: challenge,
        expectedOrigin: entry.origin,
        expectedRPID: entry.rpId,
        requireUserVerification: true,
        // Counter 0 turns off the library's own check, which throws without telling us why; we do it below.
        credential: {
          id: row.id,
          publicKey: row.public_key,
          counter: 0,
          transports: TransportsSchema.catch([]).parse(JSON.parse(row.transports)) as never,
        },
      })
    } catch {
      return fail()
    }
    if (!verified.verified) return fail()
    const next = verified.authenticationInfo.newCounter
    // Signature checking was asynchronous: decide on the row as it is now (removed, flagged or advanced by a parallel
    // assertion in the meantime), in one synchronous transaction with the update.
    const outcome = this.db.tx((sqlite) => {
      const current = this.row(row.id)
      if (
        !current ||
        current.flagged_at !== null ||
        !Buffer.from(current.public_key).equals(row.public_key)
      )
        return 'refused' as const
      // Counters that are always zero (many synced passkeys) are fine; once a counter is in use it must grow.
      if ((current.counter > 0 || next > 0) && next <= current.counter) {
        sqlite.prepare('UPDATE passkeys SET flagged_at = ? WHERE id = ?').run(this.clock(), row.id)
        return 'refused' as const
      }
      sqlite
        .prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?')
        .run(next, this.clock(), row.id)
      return 'ok' as const
    })
    if (outcome === 'refused') return fail()
    return {
      id: row.id,
      label: row.label,
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: new Date(this.clock()).toISOString(),
      flagged: false,
    }
  }
}
