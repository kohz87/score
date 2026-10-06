import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import { buildApp } from './app.ts'
import { SqliteSessionStore } from './auth/sqlite-session-store.ts'
import type { Config } from './config.ts'
import { createHermesPort, type HermesPort } from './hermes/index.ts'
import { acquireHomeLock, getEpoch, migrate, openDatabase, type ScoreDb } from './db/index.ts'
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
  let retention: NodeJS.Timeout | undefined
  let port: HermesPort | undefined
  let closing: Promise<void> | undefined

  async function closeResources(): Promise<void> {
    clearInterval(retention)
    try {
      await port?.stop()
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
    ingest = createIngest(database)
    port = createHermesPort(config, {
      onError: (error) => app?.log.error({ err: error }, 'Fake observation failed'),
    })
    app = buildApp({
      config,
      port,
      ...(logger === undefined ? {} : { logger }),
      db: database,
      ingest,
      getEpoch: () => getEpoch(database),
      sessionStore: new SqliteSessionStore(database),
    })
    const token = app.pairing.createToken()
    if (listen) await listen(app)
    else await app.listen({ host: config.host, port: config.port })
    await port.start(ingest)
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
