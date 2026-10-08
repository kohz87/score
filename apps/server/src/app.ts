import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { CONTRACT_VERSION, type SystemStatus } from '@score/contract'
import type { Config } from './config.ts'
import { ApprovalOutbox } from './domain/approval-outbox.ts'
import { registerAgentRoutes } from './http/agents.ts'
import { registerTaskRoutes } from './http/tasks.ts'
import { registerRoutineRoutes } from './http/routines.ts'
import { registerSettingsRoutes } from './http/settings.ts'
import { registerRoomRoutes } from './http/rooms.ts'
import { registerApprovalRoutes } from './http/approvals.ts'
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
import {
  createHermesPort,
  registerBridgeRoutes,
  type BridgeDeps,
  type HermesPort,
} from './hermes/index.ts'

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
  bridge?: BridgeDeps
  outbox?: ApprovalOutbox
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
  getSystemStatus = () => defaultSystemStatus(config, port, db, clock),
  streamOptions,
  bridge,
  outbox,
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
  const approvalsOutbox =
    outbox ??
    (db && ingest
      ? new ApprovalOutbox({
          db,
          ingest,
          port,
          getDisabled: () =>
            bridge?.getCompatibility().disabled ?? port.status().compatibility.disabled,
          ...(clock ? { clock } : {}),
        })
      : undefined)
  if (bridge)
    registerBridgeRoutes(app, {
      ...bridge,
      ...(approvalsOutbox ? { outbox: approvalsOutbox } : {}),
    })
  if (db && ingest && approvalsOutbox) {
    registerApprovalRoutes(app, {
      db,
      ingest,
      outbox: approvalsOutbox,
      disabled: () => bridge?.getCompatibility().disabled ?? port.status().compatibility.disabled,
      ...(clock ? { clock } : {}),
    })
    app.addHook('preClose', async () => {
      approvalsOutbox.notifier.close()
    })
    app.addHook('onClose', async () => {
      await approvalsOutbox.stop()
    })
  }
  registerTaskRoutes(app, port, ingest, db, clock)
  registerAgentRoutes(app, port, ingest, db, clock)
  registerRoutineRoutes(app, port, db, clock)
  registerSettingsRoutes(app, port, db, clock)
  if (db && ingest) registerRoomRoutes(app, port, db, ingest, clock)
  app.get('/api/health', async () => ({ ok: true, contract: CONTRACT_VERSION }))
  registerSessionRoutes(app, app.pairing)
  registerSystemRoutes(app, getSystemStatus)
  if (db && ingest && getEpoch) {
    registerStreamRoute(app, { db, ingest, getEpoch, getSystemStatus, ...streamOptions })
  }
  return app
}
