import type { FastifyInstance } from 'fastify'
import {
  HermesUpdateCheckRequestSchema,
  HermesUpdateCheckSchema,
  HermesUpdateJobSchema,
  HermesUpdateStartRequestSchema,
  HermesUpdateStatusSchema,
} from '@score/contract'
import { humanGuard } from '../auth/human.ts'
import type { SecurityPassword } from '../auth/security-password.ts'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import type { HermesUpdates } from '../hermes/index.ts'
import { requestIdempotency } from './idempotency.ts'
import { sessionKey } from './session.ts'

/**
 * 3.15.0 (owner): Settings › System › Hermes updates. Reading and checking need a paired person; starting an update
 * changes Hermes and restarts every agent, so it also needs the security password (its receipt never holds a plain
 * hash of a body carrying it).
 */
export function registerHermesUpdateRoutes(
  app: FastifyInstance,
  options: {
    updates: HermesUpdates | undefined
    security: SecurityPassword | undefined
    db?: ScoreDb | undefined
    clock?: () => number
  },
): void {
  const guard = humanGuard(app.pairing)
  const receipts = requestIdempotency(options.db, options.clock ?? Date.now, undefined, {
    secretBody: true,
  })
  const needed = () => {
    if (!options.updates)
      throw new HttpError(501, 'unsupported', 'Updating Hermes isn’t available here.')
    return options.updates
  }

  app.get('/api/system/hermes-update', { preHandler: guard }, async () => {
    if (!options.updates)
      return HermesUpdateStatusSchema.parse({
        available: false,
        version: null,
        lastCheck: null,
        job: null,
        diskFreeBytes: null,
        backupNeedsBytes: null,
      })
    return HermesUpdateStatusSchema.parse(await options.updates.status())
  })

  // Read-only (`hermes update --check` and `--plan`), but slow and a person's action.
  app.post('/api/system/hermes-update/check', { preHandler: guard }, async (request) => {
    const { channel } = HermesUpdateCheckRequestSchema.parse(request.body)
    return HermesUpdateCheckSchema.parse(await needed().check(channel))
  })

  app.post(
    '/api/system/hermes-update/start',
    { preHandler: [guard, receipts.preHandler], onSend: receipts.onSend },
    async (request, reply) => {
      const body = HermesUpdateStartRequestSchema.parse(request.body)
      const updates = needed()
      if (!options.security) throw new HttpError(501, 'unsupported', 'Not available here.')
      await options.security.verify(body.password, sessionKey(request.headers.cookie))
      const job = await updates.start({ channel: body.channel, testAgentId: body.testAgentId })
      return reply.code(202).send(HermesUpdateJobSchema.parse(job))
    },
  )
}
