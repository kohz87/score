import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.ts'
import { HttpError } from '../errors.ts'
import { readCookie, SESSION_COOKIE, sessionCookie } from './cookies.ts'

const publicRoutes = new Set([
  'POST /api/session/pair',
  'GET /api/session',
  // Passkey sign-in (5.28): options, then the assertion; both are rate limited and single-use.
  'POST /api/session/passkey/authentication-options',
  'POST /api/session/passkey/authentication',
  'GET /api/health',
  // The HTTPS setup guide and the public CA certificate (never the key).
  'GET /setup/https',
  'GET /setup/https/score-ca.crt',
])

// Share links (PLAN 5.26): the one public, token-guarded page and its images. GET only; the route answers every
// failure with the same static page.
const SHARE_PATH = /^\/s\/[A-Za-z0-9_-]{1,64}(?:\/media\/\d{1,4})?$/

export function registerRemoteGuard(
  app: FastifyInstance,
  config: Config,
  assets: ReadonlySet<string>,
): void {
  if (!config.remote) {
    registerLocalHostGuard(app, config)
    return
  }
  const authorities = new Set(config.remote.origins.map((origin) => new URL(origin).host))
  // Handlers may set their own cache policy (media: private, 1 h); remote responses must never outlive the session.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store')
    return payload
  })
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!request.headers.host || !authorities.has(request.headers.host))
      throw new HttpError(403, 'forbidden', 'Score doesn’t accept requests for this host name.')
    const path = request.url.split('?', 1)[0]!
    // Match raw paths exactly: encoded aliases and Fastify's automatic HEAD routes are private.
    if (
      publicRoutes.has(`${request.method} ${path}`) ||
      (request.method === 'GET' && SHARE_PATH.test(path)) ||
      (request.method === 'GET' && (assets.has(path) || isAppPath(path)))
    )
      return
    if (!app.pairing.isPaired(request.headers.cookie))
      throw new HttpError(
        401,
        'not_paired',
        'Pair this browser to use Score. Open the pairing link shown in the server terminal.',
      )
    if (path !== '/api/stream') app.pairing.touch(request.headers.cookie, request.ip)
    // Session routes set their own cookie (sign out clears it); everything else keeps the cookie as long as the session.
    // The stream hijacks its response and never sends this header, so it must not consume the refresh.
    if (!path.startsWith('/api/session') && path !== '/api/stream') {
      const maxAge = app.pairing.cookieRefresh(request.headers.cookie)
      const id = readCookie(request.headers.cookie, SESSION_COOKIE)
      if (maxAge !== undefined && id)
        reply.header('set-cookie', sessionCookie(id, maxAge, Boolean(config.remote?.tlsCert)))
    }
  })
}

const loopbackOn = (host: string, port: number): boolean =>
  ['127.0.0.1', 'localhost', '[::1]'].some((name) => host === `${name}:${port}`)

// Local mode answers only requests addressed to a loopback name on one of its own ports (the server's, and the dev web
// server's that proxies to it), reads included: a page reaching this port through DNS rebinding carries its own name.
function registerLocalHostGuard(app: FastifyInstance, config: Config): void {
  const web = new URL(config.webOrigin)
  const ports = new Set([
    String(config.port),
    web.port || (web.protocol === 'https:' ? '443' : '80'),
  ])
  const authorities = new Set<string>([web.host])
  for (const name of ['127.0.0.1', 'localhost', '[::1]'])
    for (const port of ports) authorities.add(`${name}:${port}`)
  if (!['0.0.0.0', '::', ''].includes(config.host))
    authorities.add(
      `${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`,
    )
  app.addHook('onRequest', async (request) => {
    const host = (request.headers.host ?? '').toLowerCase()
    // The socket's own port counts too: whatever port this listener really bound is, by definition, its own.
    const bound = request.socket.localPort
    if (!authorities.has(host) && !(bound !== undefined && loopbackOn(host, bound)))
      throw new HttpError(403, 'forbidden', 'Score doesn’t accept requests for this host name.')
  })
}

// In-app paths (/now, /chat/…) get the same public index.html as "/", so an unpaired browser opening a bookmark sees
// the pairing screen instead of a JSON error. API, bridge and file-like paths stay private.
function isAppPath(path: string): boolean {
  // Knowledge deep links end in .md and may hold encoded spaces.
  if (path.startsWith('/knowledge/')) return !path.includes('..') && !/%2e/i.test(path)
  return (
    !path.startsWith('/api/') &&
    !path.startsWith('/bridge/') &&
    !/\.[a-z0-9]+$/i.test(path) &&
    !path.includes('%') &&
    !path.includes('..')
  )
}
