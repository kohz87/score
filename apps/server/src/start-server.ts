import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { createSecureContext } from 'node:tls'
import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import { ApprovalOutbox } from './domain/approval-outbox.ts'
import { sweepExpiredApprovals } from './domain/approval-expiry.ts'
import { buildApp, buildBridgeApp } from './app.ts'
import { loadWebAssets, type WebAssets } from './http/web-assets.ts'
import { SqliteSessionStore } from './auth/sqlite-session-store.ts'
import type { Config } from './config.ts'
import {
  createHermesPort,
  createScreenshotImporter,
  loadBridgeBootstrap,
  pruneBridge,
  sweepKanbanDenials,
  type HermesPort,
} from './hermes/index.ts'
import {
  acquireHomeLock,
  getEpoch,
  migrate,
  resetEpoch,
  openDatabase,
  type ScoreDb,
} from './db/index.ts'
import { deriveBriefEvents } from './domain/briefs.ts'
import { deriveTaskEvents } from './domain/tasks.ts'
import { createIngest, type Ingest } from './hub/ingest.ts'
import { rotateLog } from './log-rotation.ts'
import { pruneEvents } from './hub/retention.ts'
import { MediaStore } from './media/store.ts'
import { retireIngestKeys, retireMedia } from './hub/retire.ts'

interface StartServerOptions {
  logger?: FastifyServerOptions['logger']
  listen?: (app: FastifyInstance) => Promise<unknown>
  listenBridge?: (app: FastifyInstance) => Promise<unknown>
  webDirectory?: string
}

export async function startServer(
  config: Config,
  { logger, listen, listenBridge, webDirectory }: StartServerOptions = {},
) {
  let https: { cert: Buffer; key: Buffer } | undefined
  let webAssets: WebAssets | undefined
  // Validate transport and the build before opening Score state or starting the adapter.
  if (config.remote) {
    if (config.remote.tlsCert && config.remote.tlsKey) {
      https = { cert: readFileSync(config.remote.tlsCert), key: readFileSync(config.remote.tlsKey) }
      createSecureContext(https)
    }
  }
  if (config.remote || config.serveWeb)
    webAssets = loadWebAssets(
      webDirectory ?? fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    )
  let db: ScoreDb | undefined
  let app: FastifyInstance | undefined
  let bridgeApp: FastifyInstance | undefined
  let homeLock: ReturnType<typeof acquireHomeLock> | undefined
  let ingest: Ingest | undefined
  let outbox: ApprovalOutbox | undefined
  let denialSweep: Promise<void> | undefined
  let deliverySweep: NodeJS.Timeout | undefined
  let retention: NodeJS.Timeout | undefined
  let logRotation: NodeJS.Timeout | undefined
  let port: HermesPort | undefined
  let closing: Promise<void> | undefined

  async function closeResources(): Promise<void> {
    clearInterval(retention)
    clearInterval(logRotation)
    clearInterval(deliverySweep)
    try {
      try {
        await outbox?.stop()
      } finally {
        await denialSweep
        await port?.stop()
      }
    } finally {
      try {
        try {
          await bridgeApp?.close()
        } finally {
          await app?.close()
        }
      } finally {
        try {
          await ingest?.close()
        } finally {
          closeDatabase()
        }
      }
    }
  }

  function closeDatabase(): void {
    try {
      db?.close()
    } finally {
      homeLock?.release()
    }
  }

  function close(): Promise<void> {
    closing ??= closeResources()
    return closing
  }

  try {
    homeLock = acquireHomeLock(config.home)
    db = openDatabase(join(config.home, 'score.db'))
    migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
    // A new epoch per start: a database restored from a backup may have caught up past a browser's cursor,
    // and only a changed epoch tells that browser its projections came from discarded history.
    resetEpoch(db)
    const database = db
    ingest = createIngest(database, {
      deriveEvents: (sqlite, drafts, context) => [
        ...deriveTaskEvents(sqlite, drafts, context),
        ...deriveBriefEvents(sqlite, drafts, context),
      ],
    })
    port = createHermesPort(config, {
      db: database,
      onError: (error) => app?.log.error({ err: error }, 'Hermes observation failed'),
    })
    const adapter = port
    outbox = new ApprovalOutbox({
      db: database,
      ingest,
      port,
      onError: (error) => app?.log.error({ err: error }, 'Approval delivery failed'),
    })
    const dispatcher = outbox
    const media = new MediaStore(database, join(config.home, 'media'), {
      ...(config.mediaQuotaMb ? { quotaBytes: config.mediaQuotaMb * 1024 * 1024 } : {}),
    })
    const bridge =
      config.mode === 'live'
        ? {
            db: database,
            ingest,
            bootstrapHash: loadBridgeBootstrap(config.home),
            getCompatibility: () => adapter.status().compatibility,
            importScreenshot: createScreenshotImporter(config, media),
          }
        : undefined
    app = buildApp({
      config,
      port,
      outbox,
      media,
      ...(logger === undefined ? {} : { logger }),
      db: database,
      ingest,
      getEpoch: () => getEpoch(database),
      sessionStore: new SqliteSessionStore(database),
      ...(bridge ? { bridge } : {}),
      ...(https ? { https } : {}),
      ...(webAssets ? { webAssets } : {}),
    })
    const token = app.pairing.createToken()
    if (config.remote) {
      bridgeApp = buildBridgeApp(bridge, outbox, logger ?? false)
      try {
        if (listenBridge) await listenBridge(bridgeApp)
        else await bridgeApp.listen({ host: '127.0.0.1', port: config.remote.bridgePort })
      } catch (error) {
        throw new Error('Could not bind the loopback bridge listener', { cause: error })
      }
      if (config.remote.insecureHttp)
        app.log.warn(
          'PLAIN HTTP: anyone on this network could read and control Score. Use TLS; SCORE_REMOTE_INSECURE_HTTP=accept acknowledges this risk.',
        )
    }
    try {
      if (listen) await listen(app)
      else await app.listen({ host: config.host, port: config.port })
    } catch (error) {
      if (!config.remote) throw error
      throw new Error('Could not bind the browser listener', { cause: error })
    }
    await port.start(ingest)
    // Warm the per-profile caches, so the first page load after a restart doesn't wait ~15 s on cold Hermes reads.
    const warming = port
    void Promise.resolve()
      .then(() => warming.listAgents())
      .catch(() => undefined)
    await outbox.start()
    const observations = ingest
    deliverySweep = setInterval(() => {
      if (config.mode === 'live' && !denialSweep) {
        denialSweep = sweepKanbanDenials(database, observations, config)
          .catch(() => app?.log.error('Kanban denial sweep failed'))
          .finally(() => {
            denialSweep = undefined
          })
      }
      void dispatcher
        .sweep()
        .catch((error: unknown) => app?.log.error({ err: error }, 'Delivery sweep failed'))
    }, 10_000)
    deliverySweep.unref()
    retention = setInterval(
      () => {
        try {
          pruneEvents(database)
        } catch (error) {
          app?.log.error({ err: error }, 'Event retention prune failed')
        }
        try {
          retireIngestKeys(database)
        } catch (error) {
          app?.log.error({ err: error }, 'Ingest key retirement failed')
        }
        try {
          if (app?.media) retireMedia(app.media)
        } catch (error) {
          app?.log.error({ err: error }, 'Media cleanup failed')
        }
        try {
          pruneBridge(database)
          if (ingest)
            void sweepExpiredApprovals(database, ingest).catch((error: unknown) =>
              app?.log.error({ err: error }, 'Approval expiry failed'),
            )
        } catch (error) {
          app?.log.error({ err: error }, 'Bridge retention prune failed')
        }
      },
      60 * 60 * 1000,
    )
    retention.unref()
    // The launcher names the file its output goes to; without it (tests, dev) nothing is rotated.
    const logFile = process.env.SCORE_LOG_FILE
    if (logFile) {
      logRotation = setInterval(() => {
        try {
          rotateLog(logFile)
        } catch (error) {
          app?.log.error({ err: error }, 'Log rotation failed')
        }
      }, 60_000)
      logRotation.unref()
    }
    return { app, bridgeApp, pairingToken: token, ingest, db: database, close }
  } catch (error) {
    try {
      await close()
    } catch (closeError) {
      app?.log.error({ err: closeError }, 'Startup cleanup failed')
    }
    throw error
  }
}
