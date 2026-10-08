import { loadConfig } from './config.ts'
import { startServer } from './start-server.ts'
import { formatStartupError } from './startup-error.ts'
import { createInterface } from 'node:readline'
import { serverOrigin } from './config.ts'

try {
  const config = loadConfig(process.env)
  const server = await startServer(config)
  const pairingOrigin = config.remote ? serverOrigin(config) : config.webOrigin
  const consoleInput =
    config.remote && process.stdin.isTTY ? createInterface({ input: process.stdin }) : undefined
  consoleInput?.on('line', (line) => {
    if (line.trim() === 'pair')
      process.stdout.write(
        `Pair this browser: ${pairingOrigin}/pair#${server.app.pairing.createToken()}\n`,
      )
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      consoleInput?.close()
      void server.close().catch((error: unknown) => {
        process.stderr.write(`Score server could not close: ${String(error)}\n`)
        process.exitCode = 1
      })
    })
  }
  if (config.remote)
    process.stdout.write('Type pair in this terminal to mint a new pairing link.\n')
  process.stdout.write(`Pair this browser: ${pairingOrigin}/pair#${server.pairingToken}\n`)
} catch (error) {
  process.stderr.write(`${formatStartupError(error)}\n`)
  process.exitCode = 1
}
