import type { FastifyInstance } from 'fastify'
import { BotInputSchema, BotTakeoverRefSchema, BotTakeoverRequestSchema } from '@score/contract'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { SecurityPassword } from '../auth/security-password.ts'
import type { ScoreDb } from '../db/index.ts'
import { readAgent } from '../domain/agents.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import { requestIdempotency } from './idempotency.ts'
import { sessionKey } from './session.ts'

const UNLOCK_MS = 5 * 60_000
const ParamsSchema = z.object({ agentId: z.string().min(1).max(100) })

/**
 * 3.17.0 (owner): take over an agent's Bot Desktop (docs/briefs/3.17.0-take-over.md). A paired person with the
 * security password (or a session unlocked with it in the last 5 minutes, which a passkey can do) takes control
 * through Hermes' lease; only that browser session then sees the screen and sends input.
 */
export function registerBotTakeoverRoutes(
  app: FastifyInstance,
  options: {
    port: HermesPort
    db: ScoreDb
    security: SecurityPassword | undefined
    clock?: () => number
  },
): void {
  const guard = humanGuard(app.pairing)
  const receipts = requestIdempotency(options.db, options.clock ?? Date.now, undefined, {
    secretBody: true,
  })
  const { port } = options

  function agentOf(params: unknown) {
    const { agentId } = ParamsSchema.parse(params)
    const agent = readAgent(options.db.sqlite, agentId)
    if (!agent || (agent.lifecycle && agent.lifecycle.state !== 'ready'))
      throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    return agentId
  }
  function supported<T>(method: T | undefined): T {
    if (!method) throw new HttpError(501, 'unsupported', 'Taking over isn’t available here.')
    return method
  }
  const lost = () =>
    new HttpError(409, 'conflict', 'You don’t have control of this screen any more.')

  app.post(
    '/api/agents/:agentId/bot-screen/take-over',
    { preHandler: [guard, receipts.preHandler], onSend: receipts.onSend },
    async (request) => {
      const agentId = agentOf(request.params)
      const body = BotTakeoverRequestSchema.parse(request.body ?? {})
      const cookie = request.headers.cookie
      if (!app.pairing.touchUnlock(cookie, UNLOCK_MS)) {
        if (!options.security) throw new HttpError(501, 'unsupported', 'Not available here.')
        await options.security.verify(body.password, sessionKey(cookie))
      }
      const take = supported(port.botScreenTake?.bind(port))
      const result = await take(agentId, sessionKey(cookie))
      if (!result.ok)
        throw new HttpError(
          result.code === 'busy' || result.code === 'not_running'
            ? 409
            : result.code === 'unavailable'
              ? 503
              : 502,
          result.code === 'busy' || result.code === 'not_running' ? 'conflict' : 'unavailable',
          result.message,
        )
      return {
        takeoverId: result.takeoverId,
        since: new Date(result.since).toISOString(),
        expiresAt: new Date(result.expiresAt).toISOString(),
      }
    },
  )

  // Input is never replayed (a retried batch would type twice): no receipts, and the page never retries a batch.
  app.post(
    '/api/agents/:agentId/bot-screen/input',
    { preHandler: guard },
    async (request, reply) => {
      const agentId = agentOf(request.params)
      const { takeoverId, events } = BotInputSchema.parse(request.body)
      const input = supported(port.botScreenInput?.bind(port))
      if ((await input(agentId, sessionKey(request.headers.cookie), takeoverId, events)) !== 'sent')
        throw lost()
      return reply.code(204).send()
    },
  )

  app.post(
    '/api/agents/:agentId/bot-screen/heartbeat',
    { preHandler: guard },
    async (request, reply) => {
      const agentId = agentOf(request.params)
      const { takeoverId } = BotTakeoverRefSchema.parse(request.body)
      const beat = supported(port.botScreenHeartbeat?.bind(port))
      if (!beat(agentId, sessionKey(request.headers.cookie), takeoverId)) throw lost()
      return reply.code(204).send()
    },
  )

  // Handing back twice, or after control already went back, is fine: the agent has its screen either way.
  app.post(
    '/api/agents/:agentId/bot-screen/hand-back',
    { preHandler: guard },
    async (request, reply) => {
      const agentId = agentOf(request.params)
      const { takeoverId } = BotTakeoverRefSchema.parse(request.body)
      const handBack = supported(port.botScreenHandBack?.bind(port))
      await handBack(agentId, sessionKey(request.headers.cookie), takeoverId)
      return reply.code(204).send()
    },
  )
}
