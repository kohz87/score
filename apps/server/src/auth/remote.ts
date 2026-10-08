import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.ts'
import { HttpError } from '../errors.ts'

const publicRoutes = new Set(['POST /api/session/pair', 'GET /api/session', 'GET /api/health'])

export function registerRemoteGuard(
  app: FastifyInstance,
  config: Config,
  assets: ReadonlySet<string>,
): void {
  if (!config.remote) return
  const authorities = new Set(config.remote.origins.map((origin) => new URL(origin).host))
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!request.headers.host || !authorities.has(request.headers.host))
      throw new HttpError(403, 'forbidden', 'Request host is not allowed')
    const path = request.url.split('?', 1)[0]!
    // Match raw paths exactly: encoded aliases and Fastify's automatic HEAD routes are private.
    if (
      publicRoutes.has(`${request.method} ${path}`) ||
      (request.method === 'GET' && (assets.has(path) || isAppPath(path)))
    )
      return
    if (!app.pairing.isPaired(request.headers.cookie))
      throw new HttpError(401, 'not_paired', 'Pair this browser to access Score')
    if (path !== '/api/stream') app.pairing.touch(request.headers.cookie, request.ip)
  })
}

// In-app paths (/now, /chat/…) get the same public index.html as "/", so an unpaired browser opening a bookmark sees
// the pairing screen instead of a JSON error. API, bridge and file-like paths stay private.
function isAppPath(path: string): boolean {
  return (
    !path.startsWith('/api/') &&
    !path.startsWith('/bridge/') &&
    !/\.[a-z0-9]+$/i.test(path) &&
    !path.includes('%') &&
    !path.includes('..')
  )
}
