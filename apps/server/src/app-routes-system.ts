import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { SystemStatus } from '@score/contract'
import type { BuildAppOptions } from './app-options.ts'
import type { Config } from './config.ts'
import type { ScoreDb } from './db/index.ts'
import type { Ingest } from './hub/ingest.ts'
import type { HermesPort } from './hermes/index.ts'
import type { CodingRuntime } from './runtimes/coding/service.ts'
import type { SecurityPassword } from './auth/security-password.ts'
import type { UpdateFetcher } from './domain/about.ts'
import type { StreamRouteOptions } from './http/stream.ts'
import type { WebAssets } from './http/web-assets.ts'
import type { MediaStore } from './media/store.ts'
import { serverOrigin } from './config.ts'
import { allowedOriginsFor } from './auth/csrf.ts'
import { PasskeyService } from './auth/passkeys.ts'
import { createFakeHermesUpdates, createLiveHermesUpdates } from './hermes/index.ts'
import { pidfdSupport } from './runtimes/coding/pidfd-signal.ts'
import { registerAboutRoutes } from './http/about.ts'
import { registerBotTakeoverRoutes } from './http/bot-takeover.ts'
import { registerCodingAgentRoutes } from './http/coding-agents.ts'
import { registerHermesUpdateRoutes } from './http/hermes-update.ts'
import { registerHttpsGuide } from './http/https-guide.ts'
import { registerLogRoutes } from './http/logs.ts'
import { registerSessionRoutes } from './http/session.ts'
import { registerShareRoutes } from './http/shares.ts'
import { registerStreamRoute } from './http/stream.ts'
import { registerSystemRoutes } from './http/system.ts'
import { registerWebAssets } from './http/web-assets.ts'
import { registerTerminal } from './app-terminal.ts'

export interface SystemRouteDeps {
  app: FastifyInstance
  config: Config
  db: ScoreDb | undefined
  ingest: Ingest | undefined
  port: HermesPort
  coding: CodingRuntime | undefined
  clock: (() => number) | undefined
  securityPassword: SecurityPassword | undefined
  getSystemStatus: () => SystemStatus
  getEpoch: (() => string) | undefined
  updateFetcher: UpdateFetcher | undefined
  streamOptions: Pick<StreamRouteOptions, 'heartbeatMs' | 'fanoutOptions'> | undefined
  webAssets: WebAssets | undefined
  mediaStore: MediaStore | undefined
  https: BuildAppOptions['https']
  terminal: BuildAppOptions['terminal']
}

export function registerSystemAndSessionRoutes({
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
}: SystemRouteDeps): void {
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
  const terminalUnavailable = registerTerminal({
    app,
    config,
    db,
    port,
    coding,
    securityPassword,
    https,
    terminal,
  })
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
  // 3.15.0 (owner): update Hermes from Settings › System (a simulated flow in fake mode).
  if (db)
    registerBotTakeoverRoutes(app, {
      port,
      db,
      security: securityPassword,
      ...(clock ? { clock } : {}),
    })
  registerHermesUpdateRoutes(app, {
    updates:
      config.mode === 'live' && db
        ? createLiveHermesUpdates({ db, port, config })
        : config.mode === 'fake'
          ? createFakeHermesUpdates()
          : undefined,
    security: securityPassword,
    db,
    ...(clock ? { clock } : {}),
  })
  registerLogRoutes(app, config.logFile)
  registerAboutRoutes(app, {
    config,
    db,
    getSystemStatus,
    ...(updateFetcher ? { fetcher: updateFetcher } : {}),
    ...(clock ? { clock } : {}),
  })
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
  // Which interpreter signals coding-agent processes through pidfds (Y1); shows in Settings > Logs.
  if (coding)
    app.addHook('onReady', async () => {
      const support = pidfdSupport()
      if (support.python) app.log.info(support.detail)
      else app.log.warn(support.detail)
    })
  if (config.remote) registerHttpsGuide(app, config)
  if (webAssets) registerWebAssets(app, webAssets, config.remote ? 'tls' : undefined)
}
