import type { FastifyInstance } from 'fastify'
import { serverOrigin, type Config } from '../config.ts'
import { HttpError } from '../errors.ts'

const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]']

function originAliases(origin: string): string[] {
  const url = new URL(origin)
  if (!loopbackHosts.includes(url.hostname)) return [origin]
  return loopbackHosts.map((hostname) => {
    url.hostname = hostname
    return url.origin
  })
}

export function registerCsrfGuard(app: FastifyInstance, config: Config): void {
  const allowedOrigins = new Set([config.webOrigin, serverOrigin(config)].flatMap(originAliases))
  app.addHook('onRequest', async (request) => {
    // Fastify decodes route paths, so a raw URL prefix alone can miss encoded /api requests.
    const path = (request.routeOptions.url ?? request.url).split('?', 1)[0] ?? ''
    if (!path.startsWith('/api/') || !mutatingMethods.has(request.method)) return

    const origin = request.headers.origin
    if (
      request.headers['x-score-client'] !== 'web' ||
      (origin !== undefined && !allowedOrigins.has(origin))
    ) {
      throw new HttpError(403, 'forbidden', 'Request origin or client is not allowed')
    }
  })
}
