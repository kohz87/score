import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.ts'
import { SqliteSessionStore } from './auth/sqlite-session-store.ts'
import { loadConfig } from './config.ts'
import { acquireHomeLock, getEpoch, migrate, openDatabase, type ScoreDb } from './db/index.ts'
import { createIngest, type Ingest } from './hub/ingest.ts'
import { pruneEvents } from './hub/retention.ts'
import { retireIngestKeys } from './hub/retire.ts'
import { formatStartupError } from './startup-error.ts'

let db: ScoreDb | undefined
let app: FastifyInstance | undefined
let homeLock: ReturnType<typeof acquireHomeLock> | undefined
let ingest: Ingest | undefined
let retention: NodeJS.Timeout | undefined

async function closeServer(): Promise<void> {
  clearInterval(retention)
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

function closeDatabase(): void {
  try {
    db?.close()
  } finally {
    homeLock?.release()
  }
}

try {
  const config = loadConfig(process.env)
  homeLock = acquireHomeLock(config.home)
  db = openDatabase(join(config.home, 'score.db'))
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
  const database = db
  ingest = createIngest(database)
  app = buildApp({
    config,
    db: database,
    ingest,
    getEpoch: () => getEpoch(database),
    sessionStore: new SqliteSessionStore(database),
  })
  const token = app.pairing.createToken()
  await app.listen({ host: config.host, port: config.port })
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
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await closeServer()
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown().catch((error: unknown) => {
        process.stderr.write(`Score server could not close: ${String(error)}\n`)
        process.exitCode = 1
      })
    })
  }
  process.stdout.write(`Pair this browser: ${config.webOrigin}/pair#${token}\n`)
} catch (error) {
  process.stderr.write(`${formatStartupError(error)}\n`)
  try {
    await closeServer()
  } finally {
    process.exitCode = 1
  }
}
