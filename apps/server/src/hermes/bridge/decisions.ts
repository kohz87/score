import { BridgeDecisionsRequestSchema, BridgeDecisionsResponseSchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ApprovalOutbox } from '../../domain/approval-outbox.ts'
import type { Producer } from './registry.ts'

export function registerBridgeDecisionRoutes(
  app: FastifyInstance,
  deps: {
    outbox: ApprovalOutbox
    clock: () => number
    authenticate(value: unknown): Producer
  },
): void {
  const closing = new AbortController()
  app.addHook('preClose', async () => {
    closing.abort()
    deps.outbox.notifier.close()
  })
  app.get(
    '/bridge/v1/decisions',
    {
      onRequest: async (request) => {
        deps.authenticate(request.headers.authorization)
      },
    },
    async (request, reply) => {
      const producer = deps.authenticate(request.headers.authorization)
      const { wait } = BridgeDecisionsRequestSchema.parse(request.query)
      const disconnect = new AbortController()
      const signal = AbortSignal.any([closing.signal, disconnect.signal])
      const abort = () => {
        disconnect.abort()
      }
      request.raw.once('aborted', abort)
      reply.raw.once('close', abort)
      // Use elapsed real time for the wait budget; the injected ledger clock can be frozen.
      const deadline = performance.now() + wait * 1000
      try {
        let items
        do {
          const revision = deps.outbox.notifier.revision(producer.id)
          items = await deps.outbox.claimBridge(producer.id)
          if (items.length || signal.aborted || performance.now() >= deadline) break
          await deps.outbox.notifier.wait(
            producer.id,
            revision,
            Math.max(0, deadline - performance.now()),
            signal,
          )
        } while (!signal.aborted)
        return BridgeDecisionsResponseSchema.parse({ items: items ?? [] })
      } finally {
        request.raw.removeListener('aborted', abort)
        reply.raw.removeListener('close', abort)
      }
    },
  )
  app.post(
    '/bridge/v1/decisions/:deliveryId/ack',
    {
      onRequest: async (request) => {
        deps.authenticate(request.headers.authorization)
      },
    },
    async (request, reply) => {
      const producer = deps.authenticate(request.headers.authorization)
      const { deliveryId } = z
        .object({ deliveryId: z.string().min(1).max(256) })
        .parse(request.params)
      await deps.outbox.acknowledgeBridge(producer.id, deliveryId, request.body)
      return reply.code(204).send()
    },
  )
}
