import type { Config } from './config.ts'
import { buildGuideApp } from './http/https-guide.ts'
import { INSECURE_FLAG_REMOVED, type StartServerOptions } from './start-server-options.ts'

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
