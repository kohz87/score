import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { CONTRACT_VERSION, type SystemStatus } from '@score/contract'
import type { Config } from './config.ts'
import { ApprovalOutbox } from './domain/approval-outbox.ts'
import { registerAgentRoutes } from './http/agents.ts'
import { registerProfileRoutes } from './http/profiles.ts'
import { registerAgentTabRoutes } from './http/agent-tabs.ts'
import { registerReportRoutes } from './http/reports.ts'
import { registerTaskRoutes } from './http/tasks.ts'
import { registerRoutineRoutes } from './http/routines.ts'
import { registerRulesRoutes } from './http/rules.ts'
import { registerSettingsRoutes } from './http/settings.ts'
import { registerRoomRoutes } from './http/rooms.ts'
import { registerBriefRoutes } from './http/briefs.ts'
import { createBriefControl } from './http/brief-control.ts'
import { registerTeamPauseRoutes } from './http/team-pause.ts'
import { registerMediaRoutes } from './http/media.ts'
import { MediaStore } from './media/store.ts'
import { join } from 'node:path'
import { registerNowRoutes } from './http/now.ts'
import { registerWatchRoutes } from './http/watch.ts'
import { registerApprovalRoutes } from './http/approvals.ts'
import { registerErrorHandlers } from './errors.ts'
import { registerCsrfGuard } from './auth/csrf.ts'
import { registerRemoteGuard } from './auth/remote.ts'
import { registerWebAssets, type WebAssets } from './http/web-assets.ts'
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
  registerBridgeCredentialGuard,
  type BridgeDeps,
  type HermesPort,
} from './hermes/index.ts'

declare module 'fastify' {
  interface FastifyInstance {
    pairing: PairingService
    // Present when the app has a database; Watch frame capture stores screenshots with media.store().
    media?: MediaStore
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
  media?: MediaStore
  https?: { cert: Buffer; key: Buffer }
  webAssets?: WebAssets
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
  media,
  https,
  webAssets,
}: BuildAppOptions): FastifyInstance {
  const logging = logger ?? process.env.NODE_ENV !== 'test'
  const app = Fastify({
    ...(https ? { https } : {}),
    trustProxy: false,
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
  app.decorate('pairing', new PairingService(sessionStore, clock, Boolean(config.remote)))
  registerErrorHandlers(app)
  registerRemoteGuard(app, config, new Set(webAssets ? [...webAssets.keys(), '/', '/pair'] : []))
  if (config.remote) registerBridgeCredentialGuard(app)
  registerCsrfGuard(app, config)
  app.addHook('preClose', async () => app.pairing.close())
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
  if (bridge && !config.remote)
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
  const mediaStore =
    media ??
    (db
      ? new MediaStore(db, join(config.home, 'media'), {
          ...(config.mediaQuotaMb ? { quotaBytes: config.mediaQuotaMb * 1024 * 1024 } : {}),
          ...(clock ? { clock } : {}),
        })
      : undefined)
  if (mediaStore) {
    app.decorate('media', mediaStore)
    registerMediaRoutes(app, mediaStore)
  }
  registerTaskRoutes(app, port, ingest, db, clock)
  registerReportRoutes(app, port, db, clock)
  registerAgentRoutes(app, port, ingest, db, clock)
  if (db && ingest)
    registerProfileRoutes(app, { db, ingest, port, config, ...(clock ? { clock } : {}) })
  registerAgentTabRoutes(app, port, ingest, db, clock)
  registerRoutineRoutes(app, port, db, clock)
  registerSettingsRoutes(app, port, db, clock)
  registerRulesRoutes(app, port, ingest, db, clock)
  if (db && ingest) {
    const dispatch = registerRoomRoutes(app, port, db, ingest, clock, mediaStore)
    const control = createBriefControl({ port, db, ingest, dispatch })
    registerBriefRoutes(app, { port, db, ingest, control, ...(clock ? { clock } : {}) })
    registerTeamPauseRoutes(app, { db, ingest, control, dispatch, ...(clock ? { clock } : {}) })
    registerWatchRoutes(app, { port, db, ingest })
    registerNowRoutes(app, {
      port,
      db,
      ingest,
      disabled: () => bridge?.getCompatibility().disabled ?? port.status().compatibility.disabled,
      ...(clock ? { clock } : {}),
    })
  }
  app.get('/api/health', async () => ({ ok: true, contract: CONTRACT_VERSION }))
  registerSessionRoutes(app, app.pairing, Boolean(config.remote?.tlsCert))
  registerSystemRoutes(app, getSystemStatus)
  if (db && ingest && getEpoch) {
    registerStreamRoute(app, {
      db,
      ingest,
      getEpoch,
      getSystemStatus,
      remote: Boolean(config.remote),
      ...streamOptions,
    })
  }
  if (webAssets)
    registerWebAssets(
      app,
      webAssets,
      config.remote ? (config.remote.insecureHttp ? 'http' : 'tls') : undefined,
    )
  return app
}

export function buildBridgeApp(
  bridge?: BridgeDeps,
  outbox?: ApprovalOutbox,
  logger: FastifyServerOptions['logger'] = false,
): FastifyInstance {
  const app = Fastify({ logger, trustProxy: false })
  registerErrorHandlers(app)
  app.addHook('onRequest', async (request, reply) => {
    if (request.ip !== '127.0.0.1' && request.ip !== '::1')
      return reply
        .code(403)
        .send({ error: { code: 'forbidden', message: 'Loopback listener only' } })
  })
  if (bridge) registerBridgeRoutes(app, { ...bridge, ...(outbox ? { outbox } : {}) })
  return app
}
