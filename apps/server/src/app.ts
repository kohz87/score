import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { CONTRACT_VERSION, type SystemStatus } from '@score/contract'
import type { Config } from './config.ts'
import { registerErrorHandlers } from './errors.ts'
import { registerCsrfGuard } from './auth/csrf.ts'
import { PairingService } from './auth/pairing.ts'
import type { SessionStore } from './auth/session-store.ts'
import { registerSessionRoutes } from './http/session.ts'
import { registerSystemRoutes } from './http/system.ts'
import { registerStreamRoute, type StreamRouteOptions } from './http/stream.ts'
import type { ScoreDb } from './db/index.ts'
import type { Ingest } from './hub/ingest.ts'
import { getSystemStatus as defaultSystemStatus } from './system-status.ts'
import { createHermesPort, type HermesPort } from './hermes/index.ts'

declare module 'fastify' {
  interface FastifyInstance {
    pairing: PairingService
  }
}

interface BuildAppOptions {
  config: Config
  logger?: FastifyServerOptions['logger']
  clock?: () => number
  sessionStore?: SessionStore
  db?: ScoreDb
  ingest?: Ingest
  getEpoch?: () => string
  port?: HermesPort
  getSystemStatus?: () => SystemStatus
  streamOptions?: Pick<StreamRouteOptions, 'heartbeatMs' | 'fanoutOptions'>
}

export function buildApp({
  config,
  logger,
  clock,
  sessionStore,
  db,
  ingest,
  getEpoch,
  port = createHermesPort(config),
  getSystemStatus = () => defaultSystemStatus(config, port),
  streamOptions,
}: BuildAppOptions): FastifyInstance {
  const logging = logger ?? process.env.NODE_ENV !== 'test'
  const app = Fastify({
    logger:
      logging === false
        ? false
        : {
            ...(typeof logging === 'object' ? logging : {}),
            redact: [
              'req.headers.cookie',
              'req.headers.authorization',
              'res.headers["set-cookie"]',
            ],
            serializers: {
              // Log route templates rather than client URLs, which may contain secrets.
              req: (request) => ({
                method: request.method,
                url: request.routeOptions.url,
                headers: {
                  cookie: request.headers.cookie,
                  authorization: request.headers.authorization,
                },
              }),
              res: (reply) => ({
                statusCode: reply.statusCode,
                headers: reply.getHeaders?.(),
              }),
            },
          },
  })
  app.decorate('pairing', new PairingService(sessionStore, clock))
  registerErrorHandlers(app)
  registerCsrfGuard(app, config)
  app.get('/api/health', async () => ({ ok: true, contract: CONTRACT_VERSION }))
  registerSessionRoutes(app, app.pairing)
  registerSystemRoutes(app, getSystemStatus)
  if (db && ingest && getEpoch) {
    registerStreamRoute(app, { db, ingest, getEpoch, getSystemStatus, ...streamOptions })
  }
  return app
}
