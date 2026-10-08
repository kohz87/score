import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  LocalProviderRequestSchema,
  PlatformParamSchema,
  ToolServerRequestSchema,
  type ProviderItem,
} from '@score/contract'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import type { HermesPort, ProviderBase } from '../hermes/index.ts'
import { requestIdempotency } from './idempotency.ts'

const ProviderParamsSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/) })

export function registerSettingsRoutes(
  app: FastifyInstance,
  port: HermesPort,
  db?: ScoreDb,
  clock = Date.now,
): void {
  const receipts = requestIdempotency(db, clock)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }
  // An agent uses a provider when its model's `via` names it (id or label).
  async function withUsage(items: ProviderBase[]): Promise<ProviderItem[]> {
    const agents = await port.listAgentDetails()
    return items.map((item) => ({
      ...item,
      usedBy: agents
        .filter((agent) => {
          const via = agent.model?.via.toLowerCase()
          return via === item.id || via === item.label.toLowerCase()
        })
        .map((agent) => agent.id),
    }))
  }
  app.get('/api/settings/providers', async () => ({
    items: await withUsage(await port.listProviders()),
  }))
  app.post('/api/settings/providers/local', mutation, async (request) => {
    const req = LocalProviderRequestSchema.parse(request.body)
    return (await withUsage([await port.addLocalProvider(req)]))[0]
  })
  app.post('/api/settings/providers/:id/connect', mutation, async (request) => {
    const { id } = ProviderParamsSchema.parse(request.params)
    return port.connectProvider(id)
  })
  app.get('/api/settings/connections', async () => port.listConnections())
  app.post('/api/settings/tool-servers', mutation, async (request) =>
    port.addToolServer(ToolServerRequestSchema.parse(request.body)),
  )
  app.post('/api/settings/messaging/:platform/connect', mutation, async (request) => {
    const { platform } = z.object({ platform: PlatformParamSchema }).parse(request.params)
    return port.connectMessaging(platform)
  })
}
