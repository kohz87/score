import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { readCookie, SESSION_COOKIE, sessionCookie } from '../auth/cookies.ts'
import { RateLimiter } from '../shares/rate-limit.ts'
import type { PairingService } from '../auth/pairing.ts'
import { humanGuard } from '../auth/human.ts'
import { HttpError } from '../errors.ts'
import { PairingLinkSchema } from '@score/contract'
import type { SecurityPassword } from '../auth/security-password.ts'
import type { PasskeyService } from '../auth/passkeys.ts'

// Rate limits count per paired browser; the cookie's hash names it without keeping the secret.
export function sessionKey(cookie: string | undefined): string {
  return createHash('sha256')
    .update(readCookie(cookie, SESSION_COOKIE) ?? '')
    .digest('hex')
}

const PairBodySchema = z.object({ token: z.string().max(256) })

export function registerSessionRoutes(
  app: FastifyInstance,
  pairing: PairingService,
  secure = false,
  /** Where a new device opens Score (the browser origin), for "Pair another device" links. */
  origin?: string,
  /** Guards pairing management; without it (tests) those routes are unavailable. */
  security?: SecurityPassword,
  /** Every origin a device may be sent to (SCORE_PUBLIC_ORIGINS); the first is the default. */
  origins: readonly string[] = origin ? [origin] : [],
  /** Passkeys (5.28); needs the database. */
  passkeys?: PasskeyService,
  /** The web terminal is enabled (SCORE_TERMINAL=1): reported to Settings and the terminal page. */
  terminal: { enabled: boolean; unavailable: string | null } = {
    enabled: false,
    unavailable: null,
  },
): void {
  const guarded = { preHandler: humanGuard(pairing) }
  const PasswordBody = z.object({ password: z.unknown() }).loose()
  const sessionOf = sessionKey
  async function checkPassword(body: unknown, cookie: string | undefined): Promise<void> {
    if (!security)
      throw new HttpError(501, 'unsupported', 'Pairing management is not available here')
    await security.verify(PasswordBody.parse(body ?? {}).password, sessionOf(cookie))
    // A correct password is also the "fresh second factor" the web terminal asks for (PLAN 7.3).
    pairing.markFresh(cookie)
  }
  app.post('/api/session/pair', async (request, reply) => {
    const { token } = PairBodySchema.parse(request.body)
    const id = pairing.pair(token, request.ip, request.headers['user-agent'] ?? 'Browser')
    return reply
      .header('set-cookie', sessionCookie(id, undefined, secure))
      .code(204)
      .send()
  })

  app.get('/api/session', async (request) => ({
    paired: pairing.isPaired(request.headers.cookie),
  }))

  app.delete('/api/session', async (request, reply) => {
    pairing.revoke(request.headers.cookie)
    return reply
      .header('set-cookie', sessionCookie('', 0, secure))
      .code(204)
      .send()
  })

  // Paired browsers only, in every mode (the remote guard isn't active locally). Ids are not credentials.
  app.get('/api/session/browsers', { preHandler: humanGuard(pairing) }, async (request) => ({
    items: app.pairing.browsers(request.headers.cookie),
  }))

  app.get('/api/session/security', guarded, async () => ({
    passwordSet: security?.isSet() ?? false,
    origins: [...origins],
    terminal: terminal.enabled,
    terminalUnavailable: terminal.unavailable,
  }))
  // First time from any paired browser; changing it needs the current password; a forgotten one is reset on the host.
  app.put('/api/session/security/password', guarded, async (request, reply) => {
    if (!security) throw new HttpError(501, 'unsupported', 'Not available here')
    const body = z
      .object({ password: z.unknown(), current: z.unknown().optional() })
      .parse(request.body)
    await security.set(body.password, body.current, sessionOf(request.headers.cookie))
    return reply.code(204).send()
  })

  // Lets the owner confirm the password before relying on it; a wrong guess counts like any other (5.23).
  app.post('/api/session/security/check', guarded, async (request, reply) => {
    await checkPassword(request.body, request.headers.cookie)
    return reply.code(204).send()
  })

  // Pairing management needs the security password, so a compromised paired browser can't invite another device,
  // keep itself alive or terminate the owner's pairings. The link is the same one-time, 15-minute token the console
  // prints (minting one replaces any earlier unused token).
  app.post('/api/session/pairing-links', guarded, async (request) => {
    await checkPassword(request.body, request.headers.cookie)
    if (!origin) throw new HttpError(501, 'unsupported', 'Pairing links are not available here')
    // Only a configured public origin may be put into a link; anything else is refused before a token is minted.
    const chosen = z
      .object({ origin: z.string().max(256).optional() })
      .loose()
      .parse(request.body ?? {}).origin
    if (chosen !== undefined && !origins.includes(chosen))
      throw new HttpError(400, 'bad_request', 'That is not one of the configured origins')
    const token = pairing.createToken()
    return PairingLinkSchema.parse({
      url: `${chosen ?? origin}/pair#${token}`,
      expiresAt: new Date(pairing.tokenExpiresAt()).toISOString(),
    })
  })

  app.post('/api/session/browsers/:id/renew', guarded, async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    await checkPassword(request.body, request.headers.cookie)
    return app.pairing.renewBrowser(id)
  })

  app.post('/api/session/browsers/:id/revoke', guarded, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    await checkPassword(request.body, request.headers.cookie)
    app.pairing.revokeBrowser(id)
    return reply.code(204).send()
  })

  // "Terminate all other pairings": for a device found compromised, or when unsure which one it is.
  app.post('/api/session/browsers/revoke-others', guarded, async (request) => {
    await checkPassword(request.body, request.headers.cookie)
    return { revoked: app.pairing.revokeOthers(request.headers.cookie) }
  })

  registerPasskeyRoutes()

  // Passkeys (5.28). Registering and removing need a paired browser and the security password; signing in is public
  // and rate limited like pairing, and ends in the same kind of session a pairing link creates.
  function registerPasskeyRoutes(): void {
    const needed = () => {
      if (!passkeys) throw new HttpError(501, 'unsupported', 'Passkeys are not available here')
      return passkeys
    }
    const originOf = (request: { headers: { origin?: string | undefined } }) =>
      request.headers.origin
    const ResponseBody = z.object({ response: z.record(z.string(), z.unknown()) })

    app.get('/api/session/passkeys', guarded, async (request) => {
      const service = needed()
      const scheme = secure ? 'https' : 'http'
      return {
        ...service.availability(`${scheme}://${request.headers.host ?? ''}`),
        items: service.list(),
      }
    })

    app.post('/api/session/passkeys/registration-options', guarded, async (request) => {
      const service = needed()
      await checkPassword(request.body, request.headers.cookie)
      const { label } = z
        .object({ label: z.string().trim().min(1).max(60).optional() })
        .loose()
        .parse(request.body ?? {})
      return service.registrationOptions({
        origin: originOf(request),
        session: sessionOf(request.headers.cookie),
        label: label ?? 'Passkey',
      })
    })

    app.post('/api/session/passkeys', guarded, async (request, reply) => {
      const service = needed()
      const { response } = ResponseBody.parse(request.body)
      const created = await service.register({
        origin: originOf(request),
        session: sessionOf(request.headers.cookie),
        response,
      })
      return reply.code(201).send(created)
    })

    app.post('/api/session/passkeys/:id/remove', guarded, async (request, reply) => {
      const service = needed()
      const { id } = z.object({ id: z.string().min(1).max(1400) }).parse(request.params)
      await checkPassword(request.body, request.headers.cookie)
      service.remove(id)
      return reply.code(204).send()
    })

    // Public like the assertion: its own, looser per-address limit (a sign-in asks for options once).
    const optionsLimiter = new RateLimiter(20, 60_000)
    app.post('/api/session/passkey/authentication-options', async (request) => {
      if (!optionsLimiter.allow(request.ip))
        throw new HttpError(429, 'pairing_limited', 'Wait a minute before signing in again')
      return needed().authenticationOptions({ origin: originOf(request), peer: request.ip })
    })

    app.post('/api/session/passkey/authentication', async (request, reply) => {
      const service = needed()
      const { response } = ResponseBody.parse(request.body)
      pairing.limitSignIn(request.ip)
      const used = await service.authenticate({
        origin: originOf(request),
        peer: request.ip,
        response,
      })
      // An already paired browser proving itself again (the web terminal's second factor) keeps its session: it only
      // becomes "fresh", and no second pairing is created.
      if (pairing.pairedSession(request.headers.cookie) !== undefined) {
        pairing.markFresh(request.headers.cookie)
        return reply.code(204).send()
      }
      const id = pairing.createSession(
        request.ip,
        `${request.headers['user-agent'] ?? 'Browser'} (passkey: ${used.label})`,
      )
      return reply
        .header('set-cookie', sessionCookie(id, undefined, secure))
        .code(204)
        .send()
    })
  }
}
