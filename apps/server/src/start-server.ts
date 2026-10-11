import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, realpathSync } from 'node:fs'
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
import { resolveJournalDir, type Config } from './config.ts'
import { Orchestrator } from './domain/orchestration/executor.ts'
import { GlobalFenceStore } from './domain/orchestration/fence.ts'
import { ExecutionJournal, journalScope } from './domain/orchestration/journal.ts'
import { retryUntilResolved } from './retry-until-resolved.ts'
import {
  attachFakeLead,
  createHermesPort,
  createScreenshotImporter,
  FakePort,
  loadBridgeBootstrap,
  pruneBridge,
  pruneKanbanAttempts,
  kanbanAttemptsEnabled,
  resolveHermesHome,
  RewindBroker,
  seedFakeAttempts,
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
import { ensureMessageFts } from './db/fts.ts'
import { pruneEvents } from './hub/retention.ts'
import { pruneAuxiliary } from './hub/retention-aux.ts'
import { MediaStore } from './media/store.ts'
import { KnowledgeAgentApi } from './knowledge/agent-api.ts'
import { McpAccessStore } from './mcp/access.ts'
import { KnowledgeVault } from './knowledge/vault.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { retireIngestKeys, retireMedia } from './hub/retire.ts'
import { restoreRoomHolds } from './domain/room-rewinding.ts'
import { locatorForMode } from './runtimes/coding/cli.ts'
import { CodingRuntime } from './runtimes/coding/service.ts'
import { defaultRootPolicy } from './workspace/policy.ts'

const INSECURE_FLAG_REMOVED =
  'SCORE_REMOTE_INSECURE_HTTP was removed and is ignored: Score serves its app over HTTPS only (see /setup/https)'

interface StartServerOptions {
  logger?: FastifyServerOptions['logger']
  listen?: (app: FastifyInstance) => Promise<unknown>
  listenBridge?: (app: FastifyInstance) => Promise<unknown>
  webDirectory?: string
}

/** Remote mode without a certificate: nothing but the HTTPS setup guide (no database, adapter, pairing or API). */
/** The home's identity for the execution journal: its real path (a symlinked home is the same home). */
function realHome(home: string): string {
  try {
    return realpathSync(home)
  } catch {
    return resolve(home)
  }
}

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
  let holdRecovery: { stop(): Promise<void> } | undefined
  let spendSnapshots: NodeJS.Timeout | undefined
  let port: HermesPort | undefined
  let orchestrator: Orchestrator | undefined
  let coding: CodingRuntime | undefined
  let knowledge: KnowledgeVault | undefined
  let fakeVaultDir: string | undefined
  let closing: Promise<void> | undefined
  // Background jobs that touch the database or the adapter after an await (samplers, sweeps). Shutdown stops new ones,
  // waits for these, and only then closes ingest and SQLite.
  let stopping = false
  const jobs = new Set<Promise<unknown>>()
  function track(job: Promise<unknown>): void {
    const settled = job.then(
      () => undefined,
      () => undefined,
    )
    jobs.add(settled)
    void settled.then(() => jobs.delete(settled))
  }
  async function drainJobs(): Promise<void> {
    while (jobs.size > 0) await Promise.all([...jobs])
  }
  let dualServer: Awaited<ReturnType<typeof listenDual>> | undefined
  let guideApp: FastifyInstance | undefined

  async function closeResources(): Promise<void> {
    stopping = true
    clearInterval(retention)
    clearInterval(logRotation)
    certificateRenewal?.stop()
    // An attempt already awaiting the adapter is joined with the other jobs before ingest and SQLite close.
    if (holdRecovery) track(holdRecovery.stop())
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
        await orchestrator?.close()
        await coding?.close()
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
          await drainJobs()
          await ingest?.close()
          await drainJobs()
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
    restoreRoomHolds(db.sqlite, Date.now())
    ensureMessageFts(db.sqlite)
    // Test-only: attempts for e2e against the fake adapter (it has no Kanban board to project from).
    if (
      config.mode === 'fake' &&
      kanbanAttemptsEnabled() &&
      process.env.SCORE_E2E_SEED_ATTEMPTS === '1'
    )
      seedFakeAttempts(db.sqlite)
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
    // Orchestrations (PLAN 7.5a): the execution journal lives outside the home; every start compares it with the
    // database and fences admission when they disagree (design v3).
    const journal = new ExecutionJournal(
      resolveJournalDir(config),
      journalScope(realHome(config.home)),
    )
    const fenceStore = new GlobalFenceStore(database, journal)
    const fenced = fenceStore.startupCheck()
    if (fenced.reasons.length > 0)
      process.stderr.write(
        `Orchestration admission is fenced (${fenced.reasons.join(', ')}): review the reconciliation list in Score before lifting it.\n`,
      )
    const executor = new Orchestrator({
      db: database,
      ingest,
      port,
      access: new McpAccessStore(database),
      fence: fenceStore,
      mcpAvailable: Boolean(config.remote),
      onError: (error) => app?.log.error({ err: error }, 'Orchestration executor failed'),
    })
    orchestrator = executor
    // The fake adapter has no models: a scripted lead stands in (it calls the same tools in-process).
    if (config.mode === 'fake' && port instanceof FakePort) attachFakeLead(port, executor)
    // Coding agents (PLAN 7.2): fake mode never starts a real CLI (see locatorForMode).
    const { hermesHome: runtimeHome } = config
    coding = new CodingRuntime({
      db: database,
      ingest,
      locator: locatorForMode(config.mode, process.env),
      home: config.home,
      policy: defaultRootPolicy([config.home, resolveHermesHome(runtimeHome), resolveHermesHome()]),
      onError: (error) => app?.log.error({ err: error }, 'Coding agent run failed'),
    })
    // A CLI child dies with Score: turns still marked running are interrupted before anything else runs.
    await coding.recover()
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
      stateDir: join(config.home, 'knowledge'),
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
      coding,
      ...(knowledge ? { knowledge } : {}),
      outbox,
      media,
      orchestrator: executor,
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
      bridgeApp = buildBridgeApp(
        bridge,
        outbox,
        logger ?? false,
        // The MCP server for agents (7.4d) is served on this loopback listener only.
        {
          db: database,
          access: new McpAccessStore(database),
          ingest,
          port,
          orchestrator: executor,
          ...(knowledge ? { knowledge: new KnowledgeAgentApi(knowledge, database) } : {}),
        },
      )
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
    // Only now can runs be started or stopped: recover unfinished attempts, then work event-driven.
    await executor.start()
    // Only now can the adapter read tasks. Retried (bounded) while Hermes or a write keeps failing.
    const { recoverTaskHolds, recoverPlanStarts } = app
    const recoverHolds =
      recoverTaskHolds && recoverPlanStarts
        ? async () => (await recoverTaskHolds()) + (await recoverPlanStarts())
        : recoverTaskHolds
    if (recoverHolds) {
      // 20 fast passes (30 s apart), then every 5 minutes for as long as anything is unresolved.
      holdRecovery = retryUntilResolved(
        recoverHolds,
        [...Array<number>(20).fill(30_000), 300_000],
        {
          track,
        },
      )
    }
    // Warm the per-profile caches, so the first page load after a restart doesn't wait ~15 s on cold Hermes reads.
    const warming = port
    void Promise.resolve()
      .then(() => warming.listAgents())
      .catch(() => undefined)
    await outbox.start()
    const observations = ingest
    deliverySweep = setInterval(() => {
      if (stopping) return
      if (config.mode === 'live' && !denialSweep) {
        denialSweep = sweepKanbanDenials(database, observations, config)
          .catch(() => app?.log.error('Kanban denial sweep failed'))
          .finally(() => {
            denialSweep = undefined
          })
      }
      track(
        dispatcher
          .sweep()
          .catch((error: unknown) => app?.log.error({ err: error }, 'Delivery sweep failed')),
      )
    }, 10_000)
    deliverySweep.unref()
    retention = setInterval(
      () => {
        if (stopping) return
        try {
          pruneEvents(database)
        } catch (error) {
          app?.log.error({ err: error }, 'Event retention prune failed')
        }
        try {
          pruneAuxiliary(database)
        } catch (error) {
          app?.log.error({ err: error }, 'Auxiliary retention prune failed')
        }
        try {
          if (kanbanAttemptsEnabled()) pruneKanbanAttempts(database)
        } catch (error) {
          app?.log.error({ err: error }, 'Kanban attempts retention failed')
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
            track(
              sweepExpiredApprovals(database, ingest).catch((error: unknown) =>
                app?.log.error({ err: error }, 'Approval expiry failed'),
              ),
            )
        } catch (error) {
          app?.log.error({ err: error }, 'Bridge retention prune failed')
        }
      },
      60 * 60 * 1000,
    )
    retention.unref()
    const sampler = port
    const sampleSpend = () => {
      if (stopping) return
      track(
        snapshotSessionCosts(database, sampler, Date.now()).catch((error: unknown) =>
          app?.log.error({ err: error }, 'Spend snapshot failed'),
        ),
      )
    }
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
