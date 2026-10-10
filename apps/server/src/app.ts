import type { SecureContextOptions, TlsOptions } from 'node:tls'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { CONTRACT_VERSION, type SystemStatus } from '@score/contract'
import { serverOrigin, type Config } from './config.ts'
import { SecurityPassword } from './auth/security-password.ts'
import { ApprovalOutbox } from './domain/approval-outbox.ts'
import { createAgentDirectory, withAgentDirectory } from './http/agent-directory.ts'
import { registerAgentRoutes } from './http/agents.ts'
import { registerCodingAgentRoutes } from './http/coding-agents.ts'
import { withCodingAgents } from './runtimes/coding/port.ts'
import type { CodingRuntime } from './runtimes/coding/service.ts'
import { registerProfileRoutes } from './http/profiles.ts'
import { registerAgentContextRoutes } from './http/agent-context.ts'
import { registerAgentHistoryRoutes } from './http/agent-history.ts'
import { registerAttemptRoutes } from './http/attempts.ts'
import { registerAgentTabRoutes } from './http/agent-tabs.ts'
import { registerWorkspaceRoutes } from './http/workspace.ts'
import { createAgentWorkspaces } from './workspace/agent-workspace.ts'
import { registerKnowledgeRoutes } from './http/knowledge.ts'
import { registerKnowledgeAgentRoutes } from './http/knowledge-agents.ts'
import { registerMcpAccessRoutes } from './http/mcp-access.ts'
import { McpAccessStore } from './mcp/access.ts'
import { registerMcpCredentialGuard, registerMcpRoutes, type McpRouteDeps } from './mcp/routes.ts'
import { KnowledgeAgentApi } from './knowledge/agent-api.ts'
import type { KnowledgeVault } from './knowledge/vault.ts'
import { registerReportRoutes } from './http/reports.ts'
import { registerTaskRoutes } from './http/tasks.ts'
import { registerRoutineRoutes } from './http/routines.ts'
import { registerRulesRoutes } from './http/rules.ts'
import { registerSettingsRoutes } from './http/settings.ts'
import { registerRoomRoutes } from './http/rooms.ts'
import { registerOutsideSessionRoutes } from './http/outside-sessions.ts'
import { registerShareRoutes } from './http/shares.ts'
import { registerConversationRoutes } from './http/conversations.ts'
import { registerBriefRoutes } from './http/briefs.ts'
import { registerOrchestrationRoutes } from './http/orchestrations.ts'
import type { Orchestrator } from './domain/orchestration/executor.ts'
import { createBriefControl } from './http/brief-control.ts'
import { createPlanStarter } from './http/plan-start.ts'
import { createTaskHolds } from './http/task-holds.ts'
import type { HoldOwner } from './domain/holds.ts'
import { teamPausedAt } from './domain/team-pause.ts'
import { registerTeamPauseRoutes } from './http/team-pause.ts'
import { registerMediaRoutes } from './http/media.ts'
import { MediaStore } from './media/store.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerNowRoutes } from './http/now.ts'
import { registerAgentPauseRoutes } from './http/agent-pause.ts'
import { registerWatchRoutes } from './http/watch.ts'
import { registerApprovalRoutes } from './http/approvals.ts'
import { registerErrorHandlers } from './errors.ts'
import { allowedOriginsFor, registerCsrfGuard } from './auth/csrf.ts'
import { registerRemoteGuard } from './auth/remote.ts'
import { registerTerminalRoutes, type TerminalOptions } from './http/terminal.ts'
import type { TerminalManager } from './terminal/manager.ts'
import { registerHttpsGuide } from './http/https-guide.ts'
import { registerWebAssets, type WebAssets } from './http/web-assets.ts'
import { PairingService } from './auth/pairing.ts'
import { PasskeyService } from './auth/passkeys.ts'
import type { SessionStore } from './auth/session-store.ts'
import { registerCurrencyRoutes } from './http/currency.ts'
import { registerLogRoutes } from './http/logs.ts'
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
    // Present when the app has a database. Resolves to the number of held tasks that still need another attempt.
    recoverTaskHolds?: () => Promise<number>
    recoverPlanStarts?: () => Promise<number>
    // Present only when the web terminal is on (SCORE_TERMINAL=1) and its native module loaded.
    terminals?: TerminalManager
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
  /** The knowledge vault (started by the caller); without it the Knowledge routes are not served. */
  knowledge?: KnowledgeVault
  /** TLS options for the browser listener; `SNICallback` serves named certificates (tls-names.ts). */
  https?: SecureContextOptions & Pick<TlsOptions, 'SNICallback'>
  webAssets?: WebAssets
  /** Pairing-management password; defaults to one stored in the Score home when there is a database (a real server). */
  security?: SecurityPassword
  /** Coding agents (PLAN 7.2): Claude Code / Codex CLI as team members; without it there are none. */
  coding?: CodingRuntime
  /** The orchestration executor (PLAN 7.5a); without it the orchestration routes are not served. */
  orchestrator?: Orchestrator
  /** Test hooks for the web terminal: a stand-in PTY, a launch description, limits (the origins come from config). */
  terminal?: Pick<TerminalOptions, 'spawn' | 'launch' | 'limits' | 'clock' | 'isSecure'>
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
  knowledge,
  https,
  webAssets,
  security,
  coding,
  orchestrator,
  terminal,
}: BuildAppOptions): FastifyInstance {
  const logging = logger ?? process.env.NODE_ENV !== 'test'
  // Coding agents join the team under the same port (rooms, Now, Flow and Reports see one list of agents).
  if (db && ingest && coding) port = withCodingAgents(port, coding)
  // Live Hermes reads cost seconds per profile: pages read agents from Score's projection (5.23).
  if (config.mode === 'live' && db && ingest)
    port = withAgentDirectory(
      port,
      createAgentDirectory(port, db, ingest, (error) =>
        app.log.warn({ err: error }, 'Background agent refresh failed'),
      ),
    )
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
  registerTaskRoutes(app, port, ingest, db, clock)
  registerReportRoutes(app, port, db, clock)
  registerAgentRoutes(app, port, ingest, db, clock)
  if (db && ingest)
    registerProfileRoutes(app, { db, ingest, port, config, ...(clock ? { clock } : {}) })
  registerAgentTabRoutes(app, port, ingest, db, clock)
  registerWorkspaceRoutes(app, port, config, undefined, workspaces)
  if (knowledge) {
    registerKnowledgeRoutes(app, knowledge)
    if (db) registerKnowledgeAgentRoutes(app, new KnowledgeAgentApi(knowledge, db, clock))
  }
  if (db)
    registerMcpAccessRoutes(app, {
      access: new McpAccessStore(db, clock),
      bridgePort: config.remote?.bridgePort,
    })
  registerRoutineRoutes(app, port, db, clock)
  registerSettingsRoutes(app, port, db, clock)
  registerCurrencyRoutes(app, db)
  registerRulesRoutes(app, port, ingest, db, clock)
  if (db && ingest) {
    const dispatch = registerRoomRoutes(app, port, db, ingest, clock, mediaStore, workspaces)
    registerConversationRoutes(app, { db, ingest, port, ...(clock ? { clock } : {}) })
    registerOutsideSessionRoutes(app, { db, ingest, port })
    const holds = createTaskHolds({
      port,
      db,
      ingest,
      onInert: (owner, taskIds) =>
        app.log.warn(
          { owner, taskIds },
          'Pause release skipped holds that belong to another Kanban board lineage',
        ),
    })
    const control = createBriefControl({ port, db, ingest, holds, dispatch })
    // A crash between "pause recorded" and "task parked" (or "resumed" and "unparked") leaves holds behind. The
    // server runs this once the adapter has started, and again until nothing is left (Hermes may be unreachable).
    const ownerPaused = (owner: HoldOwner) =>
      db.read((sqlite) => {
        if (owner.kind === 'team') return teamPausedAt(sqlite) !== null
        return (
          sqlite
            .prepare(
              owner.kind === 'brief'
                ? 'SELECT 1 FROM briefs WHERE id = ? AND paused_at IS NOT NULL'
                : 'SELECT 1 FROM agent_pauses WHERE agent_id = ?',
            )
            .get(owner.id) !== undefined
        )
      })
    app.decorate('recoverTaskHolds', () => holds.recover(ownerPaused))
    // Tasks that arrive after a Pause get their pending hold in the observation's transaction (deriveBriefEvents);
    // this parks them once it commits. One pass at a time; a pass that finds more pending rows runs again.
    let parking: Promise<void> | undefined
    let retryTimer: NodeJS.Timeout | undefined
    let retries = 0
    const retryParking = () => {
      if (retryTimer) return
      retryTimer = setTimeout(
        () => {
          retryTimer = undefined
          void park()
        },
        Math.min(5_000 * 3 ** retries++, 300_000),
      )
      retryTimer.unref()
    }
    app.addHook('onClose', async () => clearTimeout(retryTimer))
    let again = false
    const park = (): Promise<void> => {
      if (parking) {
        again = true
        return parking
      }
      parking = (async () => {
        do {
          again = false
          const failed = await holds.applyPending(ownerPaused).catch(() => 1)
          // Unchanged tasks emit no upsert, so a failed park needs its own retry or it waits for the next event.
          if (failed > 0) retryParking()
          else retries = 0
        } while (again)
      })().finally(() => {
        parking = undefined
      })
      return parking
    }
    ingest.onCommitted((events) => {
      if (events.some((event) => event.type === 'task.upserted' || event.type === 'brief.upserted'))
        return park()
    })
    const plans = createPlanStarter({ port, db, ingest })
    app.decorate('recoverPlanStarts', () => plans.recover())
    registerBriefRoutes(app, {
      port,
      db,
      ingest,
      control,
      plans,
      ...(orchestrator ? { orchestrator } : {}),
      ...(clock ? { clock } : {}),
    })
    if (orchestrator)
      registerOrchestrationRoutes(app, { orchestrator, db, port, ...(clock ? { clock } : {}) })
    registerTeamPauseRoutes(app, {
      db,
      ingest,
      control,
      holds,
      dispatch,
      ...(orchestrator ? { orchestrator } : {}),
      ...(clock ? { clock } : {}),
    })
    registerWatchRoutes(app, { port, db, ingest })
    registerAgentHistoryRoutes(app, { port, db })
    registerAttemptRoutes(app, { db })
    registerAgentContextRoutes(app, { port, db })
    registerAgentPauseRoutes(app, {
      db,
      ingest,
      port,
      holds,
      dispatch,
      ...(orchestrator ? { orchestrator } : {}),
      ...(clock ? { clock } : {}),
    })
    registerNowRoutes(app, {
      port,
      db,
      ingest,
      disabled: () => bridge?.getCompatibility().disabled ?? port.status().compatibility.disabled,
      ...(clock ? { clock } : {}),
    })
  }
  app.get('/api/health', async () => ({ ok: true, contract: CONTRACT_VERSION }))
  // The same origin the console prints in its pairing link.
  // The web terminal (PLAN 7.3): not registered at all unless SCORE_TERMINAL=1. A missing native module (node-pty is
  // built at install time) leaves it off and says why, rather than stopping Score.
  const securityPassword = security ?? (db ? new SecurityPassword(config.home, clock) : undefined)
  if (db && ingest && coding)
    registerCodingAgentRoutes(app, {
      coding,
      port,
      db,
      ingest,
      security: securityPassword,
      ...(config.mode === 'fake' ? { workspaceBase: join(tmpdir(), 'score-workspaces') } : {}),
      ...(clock ? { clock } : {}),
    })
  let terminalUnavailable: string | null = null
  if (config.terminal && !https) {
    // Plain-HTTP listeners (local mode) never get a shell: a terminal needs a TLS connection.
    terminalUnavailable = 'needs HTTPS (remote mode with a certificate)'
  } else if (config.terminal) {
    try {
      app.decorate(
        'terminals',
        registerTerminalRoutes(app, {
          origins: allowedOriginsFor(config),
          hostEnrolled: () => securityPassword?.hostIssued() ?? false,
          ...terminal,
        }),
      )
    } catch (error) {
      terminalUnavailable = 'node-pty not built'
      app.log.error(
        { err: error },
        'SCORE_TERMINAL=1 but the terminal module (node-pty) could not load: the terminal stays off. See docs/SETUP.md.',
      )
    }
  }
  const pairingOrigin = config.remote || config.serveWeb ? serverOrigin(config) : config.webOrigin
  registerSessionRoutes(
    app,
    app.pairing,
    Boolean(config.remote?.tlsCert),
    pairingOrigin,
    securityPassword,
    config.remote ? config.remote.origins : [pairingOrigin],
    db ? new PasskeyService(db, clock, allowedOriginsFor(config)) : undefined,
    { enabled: app.hasDecorator('terminals'), unavailable: terminalUnavailable },
  )
  if (db)
    registerShareRoutes(app, {
      db,
      port,
      security: securityPassword,
      media: mediaStore,
      origin: serverOrigin(config),
      ...(clock ? { clock } : {}),
    })
  registerSystemRoutes(app, getSystemStatus)
  registerLogRoutes(app, config.logFile)
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
  if (config.remote) registerHttpsGuide(app, config)
  if (webAssets) registerWebAssets(app, webAssets, config.remote ? 'tls' : undefined)
  return app
}

export function buildBridgeApp(
  bridge?: BridgeDeps,
  outbox?: ApprovalOutbox,
  logger: FastifyServerOptions['logger'] = false,
  /** Score's MCP server for agents (7.4d): served here, on the loopback bridge listener, and nowhere else. */
  mcp?: McpRouteDeps,
): FastifyInstance {
  const app = Fastify({ logger, trustProxy: false, forceCloseConnections: true })
  registerErrorHandlers(app)
  app.addHook('onRequest', async (request, reply) => {
    if (request.ip !== '127.0.0.1' && request.ip !== '::1')
      return reply
        .code(403)
        .send({ error: { code: 'forbidden', message: 'Loopback listener only' } })
  })
  if (bridge) registerBridgeRoutes(app, { ...bridge, ...(outbox ? { outbox } : {}) })
  if (mcp) registerMcpRoutes(app, mcp)
  return app
}
