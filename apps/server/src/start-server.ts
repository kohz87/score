import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { createSecureContext, type SecureContextOptions, type TlsOptions } from 'node:tls'
import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import { ApprovalOutbox } from './domain/approval-outbox.ts'
import { sweepExpiredApprovals } from './domain/approval-expiry.ts'
import { buildApp, buildBridgeApp } from './app.ts'
import { listenDual } from './dual-listener.ts'
import { namedCertificates, renewTailscaleCertificates } from './tls-names.ts'
import { buildGuideApp } from './http/https-guide.ts'
import { loadWebAssets, type WebAssets } from './http/web-assets.ts'
import { SqliteSessionStore } from './auth/sqlite-session-store.ts'
import type { Config } from './config.ts'
import { retryUntilResolved } from './retry-until-resolved.ts'
import {
  createHermesPort,
  createScreenshotImporter,
  loadBridgeBootstrap,
  pruneBridge,
  RewindBroker,
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
import { deriveAgentStatusEvents } from './domain/agent-status.ts'
import { deriveBriefEvents } from './domain/briefs.ts'
import { deriveTaskEvents } from './domain/tasks.ts'
import { createIngest, type Ingest } from './hub/ingest.ts'
import { rotateLog } from './log-rotation.ts'
import { snapshotSessionCosts } from './domain/spend.ts'
import { pruneEvents } from './hub/retention.ts'
import { MediaStore } from './media/store.ts'
import { KnowledgeAgentApi } from './knowledge/agent-api.ts'
import { KnowledgeVault } from './knowledge/vault.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { retireIngestKeys, retireMedia } from './hub/retire.ts'

const INSECURE_FLAG_REMOVED =
  'SCORE_REMOTE_INSECURE_HTTP was removed and is ignored: Score serves its app over HTTPS only (see /setup/https)'

interface StartServerOptions {
  logger?: FastifyServerOptions['logger']
  listen?: (app: FastifyInstance) => Promise<unknown>
  listenBridge?: (app: FastifyInstance) => Promise<unknown>
  webDirectory?: string
}

/** Remote mode without a certificate: nothing but the HTTPS setup guide (no database, adapter, pairing or API). */
export async function startGuideServer(
  config: Config,
  { logger, listen }: Pick<StartServerOptions, 'logger' | 'listen'> = {},
) {
  const app = buildGuideApp(config, logger ?? false)
  if (config.ignoredInsecureHttp) app.log.warn(INSECURE_FLAG_REMOVED)
  try {
    if (listen) await listen(app)
    else await app.listen({ host: config.host, port: config.port })
  } catch (error) {
    await app.close()
    throw new Error('Could not bind the browser listener', { cause: error })
  }
  return { app, close: () => app.close() }
}

export async function startServer(
  config: Config,
  { logger, listen, listenBridge, webDirectory }: StartServerOptions = {},
) {
  let https: (SecureContextOptions & Pick<TlsOptions, 'SNICallback'>) | undefined
  let webAssets: WebAssets | undefined
  // Validate transport and the build before opening Score state or starting the adapter.
  if (config.remote) {
    if (config.remote.tlsCert && config.remote.tlsKey) {
      https = { cert: readFileSync(config.remote.tlsCert), key: readFileSync(config.remote.tlsKey) }
      createSecureContext(https)
      if (config.remote.tlsNamesDir)
        https.SNICallback = namedCertificates(config.remote.tlsNamesDir).sniCallback
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
  let certificateRenewal: { stop(): void } | undefined
  let holdRecovery: { stop(): void } | undefined
  let spendSnapshots: NodeJS.Timeout | undefined
  let port: HermesPort | undefined
  let knowledge: KnowledgeVault | undefined
  let fakeVaultDir: string | undefined
  let closing: Promise<void> | undefined
  let dualServer: Awaited<ReturnType<typeof listenDual>> | undefined
  let guideApp: FastifyInstance | undefined

  async function closeResources(): Promise<void> {
    clearInterval(retention)
    clearInterval(logRotation)
    certificateRenewal?.stop()
    holdRecovery?.stop()
    clearInterval(spendSnapshots)
    clearInterval(deliverySweep)
    try {
      await knowledge?.close()
      if (fakeVaultDir) rmSync(fakeVaultDir, { recursive: true, force: true })
    } catch {
      // best effort: the vault's files are the owner's and are never removed (only the fake mode's temp copy)
    }
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
          // Stop accepting first, but wait for the sockets only after the apps dropped the connections they were
          // handed (open streams would otherwise hold the close forever).
          const listener = dualServer
          const stopped = listener?.server.listening
            ? new Promise<void>((resolve) => listener.server.close(() => resolve()))
            : undefined
          try {
            await app?.close()
          } finally {
            try {
              await guideApp?.close()
            } finally {
              listener?.destroyConnections()
              await stopped
            }
          }
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
        ...deriveAgentStatusEvents(sqlite, drafts, context),
      ],
    })
    const media = new MediaStore(database, join(config.home, 'media'), {
      ...(config.mediaQuotaMb ? { quotaBytes: config.mediaQuotaMb * 1024 * 1024 } : {}),
    })
    // Session rewinds (5.33): the live port asks, the bridge routes hand the command to the plugin.
    const rewindBroker = new RewindBroker()
    port = createHermesPort(config, {
      db: database,
      rewindBroker,
      imageReader: (id) => media.read(id),
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
    const liveBridge =
      config.mode === 'live'
        ? {
            db: database,
            ingest,
            bootstrapHash: loadBridgeBootstrap(config.home),
            getCompatibility: () => adapter.status().compatibility,
            importScreenshot: createScreenshotImporter(config, media),
            rewind: rewindBroker,
          }
        : undefined
    // Fake mode (tests, e2e, demos) gets a throwaway seeded vault unless SCORE_VAULT names one.
    if (config.mode === 'fake' && !config.vault)
      fakeVaultDir = mkdtempSync(join(tmpdir(), 'score-fake-vault-'))
    const knowledgeIngest = ingest
    knowledge = new KnowledgeVault({
      vault: config.vault ?? fakeVaultDir ?? join(homedir(), 'score-vault'),
      db: database,
      emit: (change) =>
        knowledgeIngest.submit({
          source: 'knowledge',
          identity: randomUUID(),
          apply: () => [{ type: 'knowledge.changed', data: change }],
        }),
      log: { warn: (object, message) => app?.log.warn(object, message) },
      seed: fakeVaultDir !== undefined,
    })
    try {
      await knowledge.start()
    } catch (error) {
      // A vault that cannot be created (permissions, read-only disk) must not stop the rest of Score.
      process.stderr.write(`Knowledge is unavailable: ${String(error)}\n`)
      await knowledge.close()
      knowledge = undefined
    }
    const bridge =
      liveBridge && knowledge
        ? { ...liveBridge, knowledge: new KnowledgeAgentApi(knowledge, database) }
        : liveBridge
    app = buildApp({
      config,
      port,
      ...(knowledge ? { knowledge } : {}),
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
    }
    if (config.ignoredInsecureHttp) app.log.warn(INSECURE_FLAG_REMOVED)
    try {
      if (listen) await listen(app)
      else if (config.remote) {
        // One port, both protocols: TLS goes to the app, plain HTTP gets the setup guide.
        guideApp = buildGuideApp(config, logger ?? false)
        dualServer = await listenDual(app, guideApp, { host: config.host, port: config.port })
      } else await app.listen({ host: config.host, port: config.port })
    } catch (error) {
      if (!config.remote) throw error
      throw new Error('Could not bind the browser listener', { cause: error })
    }
    await port.start(ingest)
    // Only now can the adapter read tasks. Retried (bounded) while Hermes or a write keeps failing.
    const { recoverTaskHolds, recoverPlanStarts } = app
    const recoverHolds =
      recoverTaskHolds && recoverPlanStarts
        ? async () => (await recoverTaskHolds()) + (await recoverPlanStarts())
        : recoverTaskHolds
    if (recoverHolds) {
      // 20 fast passes (30 s apart), then every 5 minutes for as long as anything is unresolved.
      holdRecovery = retryUntilResolved(recoverHolds, [...Array<number>(20).fill(30_000), 300_000])
    }
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
    const sampler = port
    const sampleSpend = () =>
      void snapshotSessionCosts(database, sampler, Date.now()).catch((error: unknown) =>
        app?.log.error({ err: error }, 'Spend snapshot failed'),
      )
    spendSnapshots = setInterval(sampleSpend, 10 * 60 * 1000)
    spendSnapshots.unref()
    sampleSpend()
    if (config.remote?.tlsNamesDir)
      certificateRenewal = renewTailscaleCertificates(config.remote.tlsNamesDir, (error) =>
        app?.log.warn({ err: error }, 'Could not renew a Tailscale certificate'),
      )
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
