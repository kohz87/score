import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.ts'
import { SqliteSessionStore } from './auth/sqlite-session-store.ts'
import { loadConfig } from './config.ts'
import { acquireHomeLock, migrate, openDatabase, type ScoreDb } from './db/index.ts'
import { formatStartupError } from './startup-error.ts'

let db: ScoreDb | undefined
let app: FastifyInstance | undefined
let homeLock: ReturnType<typeof acquireHomeLock> | undefined

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
  app = buildApp({ config, sessionStore: new SqliteSessionStore(db) })
  const token = app.pairing.createToken()
  await app.listen({ host: config.host, port: config.port })
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    try {
      await app?.close()
    } finally {
      closeDatabase()
    }
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
    await app?.close()
  } finally {
    closeDatabase()
    process.exitCode = 1
  }
}
