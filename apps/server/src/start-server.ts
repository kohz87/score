import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import { ApprovalOutbox } from './domain/approval-outbox.ts'
import { sweepExpiredApprovals } from './domain/approval-expiry.ts'
import { buildApp } from './app.ts'
import { SqliteSessionStore } from './auth/sqlite-session-store.ts'
import type { Config } from './config.ts'
import {
  createHermesPort,
  loadBridgeBootstrap,
  pruneBridge,
  sweepKanbanDenials,
  type HermesPort,
} from './hermes/index.ts'
import { acquireHomeLock, getEpoch, migrate, openDatabase, type ScoreDb } from './db/index.ts'
import { deriveBriefEvents } from './domain/briefs.ts'
import { deriveTaskEvents } from './domain/tasks.ts'
import { createIngest, type Ingest } from './hub/ingest.ts'
import { pruneEvents } from './hub/retention.ts'
import { retireIngestKeys } from './hub/retire.ts'

interface StartServerOptions {
  logger?: FastifyServerOptions['logger']
  listen?: (app: FastifyInstance) => Promise<unknown>
}

export async function startServer(config: Config, { logger, listen }: StartServerOptions = {}) {
  let db: ScoreDb | undefined
  let app: FastifyInstance | undefined
  let homeLock: ReturnType<typeof acquireHomeLock> | undefined
  let ingest: Ingest | undefined
  let outbox: ApprovalOutbox | undefined
  let denialSweep: Promise<void> | undefined
  let deliverySweep: NodeJS.Timeout | undefined
  let retention: NodeJS.Timeout | undefined
  let port: HermesPort | undefined
  let closing: Promise<void> | undefined

  async function closeResources(): Promise<void> {
    clearInterval(retention)
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
        await app?.close()
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
    app = buildApp({
      config,
      port,
      outbox,
      ...(logger === undefined ? {} : { logger }),
      db: database,
      ingest,
      getEpoch: () => getEpoch(database),
      sessionStore: new SqliteSessionStore(database),
      ...(config.mode === 'live'
        ? {
            bridge: {
              db: database,
              ingest,
              bootstrapHash: loadBridgeBootstrap(config.home),
              getCompatibility: () => adapter.status().compatibility,
            },
          }
        : {}),
    })
    const token = app.pairing.createToken()
    if (listen) await listen(app)
    else await app.listen({ host: config.host, port: config.port })
    await port.start(ingest)
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
    return { app, pairingToken: token, close }
  } catch (error) {
    try {
      await close()
    } catch (closeError) {
      app?.log.error({ err: closeError }, 'Startup cleanup failed')
    }
    throw error
  }
}
