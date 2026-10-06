import { loadConfig } from './config.ts'
import { startServer } from './start-server.ts'
import { formatStartupError } from './startup-error.ts'

try {
  const config = loadConfig(process.env)
  const server = await startServer(config)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void server.close().catch((error: unknown) => {
        process.stderr.write(`Score server could not close: ${String(error)}\n`)
        process.exitCode = 1
      })
    })
  }
  process.stdout.write(`Pair this browser: ${config.webOrigin}/pair#${server.pairingToken}\n`)
} catch (error) {
  process.stderr.write(`${formatStartupError(error)}\n`)
  process.exitCode = 1
}
