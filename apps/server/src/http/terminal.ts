import { createRequire } from 'node:module'
import type { FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { z } from 'zod'
import { TerminalSessionsSchema, TerminalTicketSchema } from '@score/contract'
import { humanGuard } from '../auth/human.ts'
import { HttpError } from '../errors.ts'
import { RateLimiter } from '../shares/rate-limit.ts'
import {
  TerminalManager,
  type PtyProcess,
  type SpawnPty,
  type TerminalLimits,
  type TerminalSocket,
} from '../terminal/manager.ts'
import { terminalLaunch, type TerminalLaunch } from '../terminal/env.ts'
import { FRESH_AUTH_MS, TerminalTickets } from '../terminal/tickets.ts'

export interface TerminalOptions {
  /** The browser origins that may open a terminal (the same set that may make changes). */
  origins: ReadonlySet<string>
  spawn?: SpawnPty
  launch?: TerminalLaunch
  clock?: () => number
  limits?: Partial<TerminalLimits>
  /** Has the owner set the security password on the Score machine itself (`scripts/score password`)? */
  hostEnrolled?: () => boolean
  /** Is this request on a real TLS connection? (The socket decides, never a header; tests substitute.) */
  isSecure?: (request: { raw: { socket: unknown } }) => boolean
}

const tlsSocket = (request: { raw: { socket: unknown } }): boolean =>
  (request.raw.socket as { encrypted?: boolean } | undefined)?.encrypted === true

const QuerySchema = z.object({ ticket: z.string().min(20).max(128) })

/** node-pty is a native module: load it only when the terminal is on, and say so if it was never built. */
export function loadNodePty(): SpawnPty {
  const nodePty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty')
  return (launch, size) => {
    const pty = nodePty.spawn(launch.file, launch.args, {
      name: launch.env.TERM,
      cols: size.cols,
      rows: size.rows,
      cwd: launch.cwd,
      env: launch.env,
      // Binary frames both ways: no UTF-8 decoding in the middle of a multi-byte sequence.
      encoding: null,
    })
    return pty as unknown as PtyProcess
  }
}

/**
 * The web terminal (PLAN 7.3, design docs/briefs/7.3-web-terminal.md). Only called when SCORE_TERMINAL=1; without it
 * none of these routes exist. Every route needs a paired session (the remote guard and `humanGuard`), and a terminal
 * additionally needs a one-time ticket minted right after a password or passkey check.
 */
export function registerTerminalRoutes(
  app: FastifyInstance,
  options: TerminalOptions,
): TerminalManager {
  const clock = options.clock ?? Date.now
  const tickets = new TerminalTickets(clock)
  const manager = new TerminalManager(
    options.spawn ?? loadNodePty(),
    app.log,
    options.launch ?? terminalLaunch(),
    clock,
    options.limits,
    (session) => app.pairing.isHashPaired(session),
  )
  const isSecure = options.isSecure ?? tlsSocket
  const hostEnrolled = options.hostEnrolled ?? (() => false)
  const requireTls = (request: { raw: { socket: unknown } }) => {
    if (!isSecure(request))
      throw new HttpError(426, 'https_required', 'The terminal works only over HTTPS.')
  }
  const guarded = { preHandler: humanGuard(app.pairing) }
  const mintLimit = new RateLimiter(10, 60_000, clock)
  const originOf = (request: { headers: { origin?: string | undefined } }) => {
    const origin = request.headers.origin
    if (origin === undefined || !options.origins.has(origin))
      throw new HttpError(403, 'forbidden', 'Score doesn’t accept requests from this origin.')
    return origin
  }
  const sessionOf = (cookie: string | undefined) => {
    const session = app.pairing.pairedSession(cookie)
    if (session === undefined) throw new HttpError(401, 'not_paired', 'Pair this browser first.')
    return session
  }

  app.addHook('preClose', async () => {
    await manager.closeAll('stopped')
  })

  app.post('/api/terminal/tickets', guarded, async (request) => {
    requireTls(request)
    const origin = originOf(request)
    const session = sessionOf(request.headers.cookie)
    if (!mintLimit.allow(session))
      throw new HttpError(
        429,
        'too_many_attempts',
        'Too many terminals opened. Wait a minute and try again.',
      )
    if (manager.full)
      throw new HttpError(
        429,
        'too_many_terminals',
        'Two terminals are already open. Close one first.',
      )
    // A password set from a browser proves nothing a stolen cookie couldn't also do: it must come from the host.
    if (!hostEnrolled())
      throw new HttpError(
        403,
        'second_factor_not_enrolled',
        'Set the security password on the Score machine with scripts/score password first.',
      )
    // Taken (and used up) before anything is minted: one password or passkey check opens one terminal.
    if (!app.pairing.takeFresh(session, FRESH_AUTH_MS))
      throw new HttpError(
        403,
        'fresh_auth_required',
        'Confirm your security password or passkey first.',
      )
    const minted = tickets.mint(session, origin)
    if (!minted)
      throw new HttpError(
        429,
        'too_many_attempts',
        'Too many attempts. Wait a minute and try again.',
      )
    return TerminalTicketSchema.parse({
      ticket: minted.ticket,
      expiresAt: new Date(minted.expiresAt).toISOString(),
    })
  })

  app.get('/api/terminal/sessions', guarded, async () =>
    TerminalSessionsSchema.parse({ items: manager.list() }),
  )

  app.delete('/api/terminal/sessions/:id', guarded, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params)
    if (!manager.list().some((terminal) => terminal.id === id))
      throw new HttpError(404, 'not_found', 'Couldn’t find that terminal.')
    manager.close(id, 'closed')
    return reply.code(204).send()
  })

  // The upgrade is a GET that runs the full request lifecycle (the remote guard's Host and paired-session checks
  // included); the checks below run before the socket is upgraded, so a refusal is a plain HTTP error.
  void app.register(websocket, { options: { maxPayload: 64 * 1024 } })
  void app.register(async (scope) => {
    scope.get(
      '/api/terminal/ws',
      {
        websocket: true,
        preValidation: async (request) => {
          requireTls(request)
          const origin = originOf(request)
          // Same Host rule as remote mode applies to every request; local mode has no other host check.
          if (request.headers.host !== new URL(origin).host)
            throw new HttpError(
              403,
              'forbidden',
              'Score doesn’t accept requests for this host name.',
            )
          const session = sessionOf(request.headers.cookie)
          const parsed = QuerySchema.safeParse(request.query)
          if (!parsed.success || !tickets.redeem(parsed.data.ticket, session, origin))
            throw new HttpError(
              403,
              'ticket_invalid',
              'The terminal link is invalid or has expired. Open the terminal again.',
            )
          ;(request as unknown as { terminalSession: string }).terminalSession = session
        },
      },
      (socket, request) => {
        const session = (request as unknown as { terminalSession: string }).terminalSession
        const id = manager.open(
          socket as unknown as TerminalSocket,
          session,
          request.ip || 'unknown',
        )
        if (id === undefined) return
        const forget = app.pairing.onRevoked(session, () => manager.closeSession(session))
        socket.once('close', forget)
      },
    )
  })
  return manager
}
