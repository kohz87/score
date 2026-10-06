import { buildApp } from './app.ts'
import { loadConfig } from './config.ts'
import { formatStartupError } from './startup-error.ts'

try {
  const config = loadConfig(process.env)
  const app = buildApp({ config })
  const token = app.pairing.createToken()
  await app.listen({ host: config.host, port: config.port })
  process.stdout.write(`Pair this browser: ${config.webOrigin}/pair#${token}\n`)
} catch (error) {
  process.stderr.write(`${formatStartupError(error)}\n`)
  process.exit(1)
}
