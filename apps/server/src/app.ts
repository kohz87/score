import Fastify, { type FastifyInstance } from 'fastify'
import { CONTRACT_VERSION } from '@score/contract'
import { dirname, join, resolve } from 'node:path'
import { SecurityPassword } from './auth/security-password.ts'
import { ApprovalOutbox } from './domain/approval-outbox.ts'
import { createAgentWorkspaces } from './workspace/agent-workspace.ts'
import { MediaStore } from './media/store.ts'
import { registerApprovalRoutes } from './http/approvals.ts'
import { registerMediaRoutes } from './http/media.ts'
import { registerQuestionRoutes } from './http/questions.ts'
import { registerErrorHandlers } from './errors.ts'
import { registerCsrfGuard } from './auth/csrf.ts'
import { registerRemoteGuard } from './auth/remote.ts'
import { PairingService } from './auth/pairing.ts'
import { registerMcpCredentialGuard } from './mcp/routes.ts'
import {
  createHermesPort,
  registerBridgeCredentialGuard,
  registerBridgeRoutes,
} from './hermes/index.ts'
import { getSystemStatus as defaultSystemStatus } from './system-status.ts'
import type { ScoreDb } from './db/index.ts'
import type { BuildAppOptions } from './app-options.ts'
import { routePort } from './app-route-port.ts'
import { registerDataRoutes } from './app-routes-data.ts'
import { registerCollaborationRoutes } from './app-routes-collaboration.ts'
import { registerTaskHoldParking } from './app-task-parking.ts'
import { registerWorkRoutes } from './app-routes-work.ts'
import { registerSystemAndSessionRoutes } from './app-routes-system.ts'

export { routePort }
export { buildBridgeApp } from './app-bridge.ts'

/** Whether the database file is the one in `home` (an in-memory or elsewhere database owns no home). */
function databaseInHome(db: ScoreDb, home: string): boolean {
  const file = db.sqlite.location()
  return file !== null && resolve(dirname(file)) === resolve(home)
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
  updateFetcher,
  streamOptions,
  bridge,
  outbox,
  media,
  knowledge,
  https,
  webAssets,
  security,
  coding,
  orchestrator,
  terminal,
}: BuildAppOptions): FastifyInstance {
  const logging = logger ?? process.env.NODE_ENV !== 'test'
  port = routePort({
    live: config.mode === 'live',
    port,
    coding,
    db,
    ingest,
    warn: (error) => app.log.warn({ err: error }, 'Background agent refresh failed'),
  })
  const app = Fastify({
    ...(https ? { https } : {}),
    trustProxy: false,
    // Live streams (SSE) never go idle, so the default ('idle') left `score stop` waiting on open browsers.
    forceCloseConnections: true,
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
  registerMcpCredentialGuard(app)
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
  if (db && ingest)
    registerQuestionRoutes(app, {
      db,
      ingest,
      port,
      onError: (error) => app.log.error({ err: error }, 'Answering a question failed'),
      ...(clock ? { clock } : {}),
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
  const workspaces = createAgentWorkspaces(port, config)
  // Start-up cleanups delete what the database doesn't name, so they only run against the home that database lives in:
  // a server built with a test database and the default home must never clear the owner's real ~/.score (2026-10-19).
  const ownsHome = db ? databaseInHome(db, config.home) : false
  registerDataRoutes({
    app,
    port,
    db,
    ingest,
    config,
    clock,
    mediaStore,
    knowledge,
    workspaces,
    ownsHome,
    getSecurityPassword: () => securityPassword,
  })
  const collaboration = registerCollaborationRoutes({
    app,
    port,
    db,
    ingest,
    config,
    clock,
    mediaStore,
    workspaces,
    knowledge,
    ownsHome,
    orchestrator,
    bridge,
  })
  if (collaboration && ingest) {
    registerTaskHoldParking(app, ingest, collaboration.holds, collaboration.ownerPaused)
    registerWorkRoutes({
      app,
      port,
      db,
      ingest,
      config,
      clock,
      bridge,
      orchestrator,
      holds: collaboration.holds,
      control: collaboration.control,
      dispatch: collaboration.dispatch,
      getSecurityPassword: () => securityPassword,
    })
  }
  app.get('/api/health', async () => ({ ok: true, contract: CONTRACT_VERSION }))
  // The same origin the console prints in its pairing link.
  // The web terminal (PLAN 7.3): not registered at all unless SCORE_TERMINAL=1. A missing native module (node-pty is
  // built at install time) leaves it off and says why, rather than stopping Score.
  const securityPassword =
    security ??
    (db
      ? new SecurityPassword(
          config.home,
          clock,
          undefined,
          // Fake mode guards no real credential, and its e2e specs make wrong guesses on every run from one paired browser.
          config.mode === 'fake' ? { perSession: 1000, overall: 1000 } : undefined,
        )
      : undefined)
  registerSystemAndSessionRoutes({
    app,
    config,
    db,
    ingest,
    port,
    coding,
    clock,
    securityPassword,
    getSystemStatus,
    getEpoch,
    updateFetcher,
    streamOptions,
    webAssets,
    mediaStore,
    https,
    terminal,
  })
  return app
}
