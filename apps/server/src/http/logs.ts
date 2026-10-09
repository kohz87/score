import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { LogLevelSchema, LogsResponseSchema } from '@score/contract'
import { humanGuard } from '../auth/human.ts'
import { MAX_LOG_LINES, readLogs } from '../domain/logs.ts'

/** Settings › Logs: Score's own log only (no Hermes logs), paired browsers only, redacted line by line. */
export function registerLogRoutes(app: FastifyInstance, logFile: string | undefined): void {
  const query = z
    .object({
      level: LogLevelSchema.optional(),
      q: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(MAX_LOG_LINES).default(500),
    })
    .strict()
  app.get('/api/system/logs', { preHandler: humanGuard(app.pairing) }, async (request) => {
    const q = query.parse(request.query)
    return LogsResponseSchema.parse({
      available: logFile !== undefined,
      items: logFile ? readLogs(logFile, q) : [],
    })
  })
}
