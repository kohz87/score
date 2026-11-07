import type { FastifyInstance, FastifyServerOptions } from 'fastify'

export interface StartServerOptions {
  logger?: FastifyServerOptions['logger']
  listen?: (app: FastifyInstance) => Promise<unknown>
  listenBridge?: (app: FastifyInstance) => Promise<unknown>
  webDirectory?: string
}

export const INSECURE_FLAG_REMOVED =
  'SCORE_REMOTE_INSECURE_HTTP was removed and is ignored: Score serves its app over HTTPS only (see /setup/https)'
