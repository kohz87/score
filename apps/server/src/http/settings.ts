import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  ConfigApplyRequestSchema,
  ConfigPreviewRequestSchema,
  ConfigSearchQuerySchema,
  HermesAcceptRequestSchema,
  LocalProviderRequestSchema,
  ModelsQuerySchema,
  ModelsResponseSchema,
  PatchPluginRequestSchema,
  PlatformParamSchema,
  PluginIdSchema,
  PluginsQuerySchema,
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
  // Both reads spawn Hermes processes; run them side by side (they were serial: 7-13 s per refresh).
  async function withUsage(
    pending: Promise<ProviderBase[]> | ProviderBase[],
  ): Promise<ProviderItem[]> {
    const [items, agents] = await Promise.all([pending, port.listAgentDetails()])
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
    items: await withUsage(port.listProviders()),
  }))
  app.get('/api/models', async (request) => {
    const { q } = ModelsQuerySchema.parse(request.query)
    return ModelsResponseSchema.parse({ items: await port.listModels(q) })
  })
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
  app.get('/api/settings/config', async (request) => ({
    items: await port.searchConfig(ConfigSearchQuerySchema.parse(request.query).q),
  }))
  // A check only reads (the CLI version, the gateway, Hermes's sources); it is still a person's action.
  app.post('/api/settings/hermes/check', { preHandler: [humanGuard(app.pairing)] }, async () =>
    port.checkHermes(),
  )
  app.post('/api/settings/hermes/accept', mutation, async (request) => {
    await port.acceptHermes(HermesAcceptRequestSchema.parse(request.body).hash)
    return { ok: true }
  })
  // Preview changes nothing; it still goes through the CSRF hook like every POST.
  app.post('/api/settings/config/preview', async (request) =>
    port.previewConfig(ConfigPreviewRequestSchema.parse(request.body).changes),
  )
  app.post('/api/settings/config/apply', mutation, async (request) =>
    port.applyConfig(ConfigApplyRequestSchema.parse(request.body)),
  )
  // Plugins are per profile: `?agent=` picks whose list this is.
  app.get('/api/settings/plugins', async (request) => ({
    items: await port.listPlugins(PluginsQuerySchema.parse(request.query).agent),
  }))
  app.patch('/api/settings/plugins/:id', mutation, async (request) => {
    const { id } = z.object({ id: PluginIdSchema }).parse(request.params)
    const { agent } = PluginsQuerySchema.parse(request.query)
    const { enabled } = PatchPluginRequestSchema.parse(request.body)
    return port.setPluginEnabled(agent, id, enabled)
  })
}
