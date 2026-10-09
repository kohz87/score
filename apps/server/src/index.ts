import { loadConfig } from './config.ts'
import { startGuideServer, startServer } from './start-server.ts'
import { formatStartupError } from './startup-error.ts'
import { createInterface } from 'node:readline'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { guideOnly, serverOrigin } from './config.ts'

try {
  const config = loadConfig(process.env)
  if (guideOnly(config)) {
    // Remote mode needs a certificate: until there is one, only the setup guide is served.
    const guide = await startGuideServer(config)
    // `scripts/score pair` signals every running Score; without HTTPS there is nothing to pair with, so ignore it.
    process.on('SIGUSR2', () => {})
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.on(signal, () => {
        void guide.close().catch((error: unknown) => {
          process.stderr.write(`Score server could not close: ${String(error)}\n`)
          process.exitCode = 1
        })
      })
    process.stdout.write(
      `Score needs HTTPS before it can be used. Setup guide: ${serverOrigin(config)}/setup/https\n` +
        'Run scripts/score tls (or set SCORE_TLS_CERT and SCORE_TLS_KEY), then restart.\n',
    )
  } else {
    const server = await startServer(config)
    const pairingOrigin = config.remote || config.serveWeb ? serverOrigin(config) : config.webOrigin
    const consoleInput = process.stdin.isTTY ? createInterface({ input: process.stdin }) : undefined
    consoleInput?.on('line', (line) => {
      if (line.trim() === 'pair')
        process.stdout.write(
          `Pair this browser: ${pairingOrigin}/pair#${server.app.pairing.createToken()}\n`,
        )
    })
    // `scripts/score pair` sends SIGUSR2; the link goes to a 0600 file in SCORE_HOME, never to the network.
    process.on('SIGUSR2', () => {
      try {
        const file = join(config.home, 'pair-link')
        writeFileSync(
          `${file}.tmp`,
          `${pairingOrigin}/pair#${server.app.pairing.createToken()}\n`,
          {
            mode: 0o600,
          },
        )
        renameSync(`${file}.tmp`, file)
      } catch (error) {
        process.stderr.write(`Could not write a pairing link: ${String(error)}\n`)
      }
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
    if (consoleInput)
      process.stdout.write('Type pair in this terminal to mint a new pairing link.\n')
    // A terminal shows the link. Anything else (the launcher's score.log) must never hold a usable link: it goes to
    // a 0600 file the launcher prints once and deletes.
    if (process.stdout.isTTY)
      process.stdout.write(`Pair this browser: ${pairingOrigin}/pair#${server.pairingToken}\n`)
    else {
      try {
        const file = join(config.home, 'pair-link')
        writeFileSync(`${file}.tmp`, `${pairingOrigin}/pair#${server.pairingToken}\n`, {
          mode: 0o600,
        })
        renameSync(`${file}.tmp`, file)
      } catch (error) {
        process.stderr.write(`Could not write a pairing link: ${String(error)}\n`)
      }
      process.stdout.write(
        `Pair this browser: ${pairingOrigin}/ (link withheld from logs; use scripts/score pair)\n`,
      )
    }
  }
} catch (error) {
  process.stderr.write(`${formatStartupError(error)}\n`)
  process.exitCode = 1
}
