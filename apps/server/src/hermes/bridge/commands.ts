import { BridgeCommandResultSchema, BridgeCommandsResponseSchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Producer } from './registry.ts'
import type { RewindBroker } from './rewind-broker.ts'

const WaitSchema = z.object({ wait: z.coerce.number().int().min(0).max(30).default(25) })

/** Contract §11 "Commands": the sibling long poll next to decisions, used for session rewinds (PLAN 5.33). */
export function registerBridgeCommandRoutes(
  app: FastifyInstance,
  deps: { broker: RewindBroker; authenticate(value: unknown): Producer },
): void {
  const closing = new AbortController()
  app.addHook('preClose', async () => {
    closing.abort()
    deps.broker.close()
  })
  const guard = {
    onRequest: async (request: { headers: { authorization?: string | undefined } }) => {
      deps.authenticate(request.headers.authorization)
    },
  }
  app.get('/bridge/v1/commands', guard, async (request, reply) => {
    const producer = deps.authenticate(request.headers.authorization)
    const { wait } = WaitSchema.parse(request.query)
    const disconnect = new AbortController()
    const signal = AbortSignal.any([closing.signal, disconnect.signal])
    const abort = () => {
      disconnect.abort()
    }
    request.raw.once('aborted', abort)
    reply.raw.once('close', abort)
    try {
      // A producer that can't tell where it runs only observes: it gets no commands.
      const items =
        producer.isolation === 'unknown'
          ? await deps.broker.claim('', wait * 1000, signal)
          : await deps.broker.claim(producer.profile, wait * 1000, signal)
      return BridgeCommandsResponseSchema.parse({ items })
    } finally {
      request.raw.removeListener('aborted', abort)
      reply.raw.removeListener('close', abort)
    }
  })
  app.post('/bridge/v1/commands/:commandId/result', guard, async (request, reply) => {
    const producer = deps.authenticate(request.headers.authorization)
    const { commandId } = z
      .object({ commandId: z.string().min(1).max(128) })
      .parse(request.params)
    deps.broker.complete(producer.profile, commandId, BridgeCommandResultSchema.parse(request.body))
    return reply.code(204).send()
  })
}
