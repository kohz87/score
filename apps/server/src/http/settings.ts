import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  ConfigApplyRequestSchema,
  ConfigPreviewRequestSchema,
  ConfigSearchQuerySchema,
  HermesAcceptRequestSchema,
  LocalProviderRequestSchema,
  MessagingFieldsResponseSchema,
  MessagingSetupRequestSchema,
  ModelsQuerySchema,
  ModelsResponseSchema,
  ModelVisibilitySchema,
  type ModelOption,
  PatchPluginRequestSchema,
  PlatformParamSchema,
  ProviderKeyRequestSchema,
  PluginIdSchema,
  PluginsQuerySchema,
  ToolServerRequestSchema,
  type ProviderItem,
} from '@score/contract'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import type { HermesPort, ProviderBase } from '../hermes/index.ts'
import { readChosenModels, replaceChosenModels } from '../domain/model-visibility.ts'
import { CUSTOM_ALIAS_REASON } from '../domain/model-aliases.ts'
import { requestIdempotency } from './idempotency.ts'

const sameRow = (a: ModelOption, b: ModelOption) => a.provider === b.provider && a.model === b.model
const SignInParamsSchema = z.object({ signInId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
const ProviderParamsSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/) })

export function registerSettingsRoutes(
  app: FastifyInstance,
  port: HermesPort,
  db?: ScoreDb,
  clock = Date.now,
): void {
  const receipts = requestIdempotency(db, clock)
  // The pasted key's route: the receipt never holds a plain hash of the body (D2.7).
  const keyReceipts = requestIdempotency(db, clock, undefined, { secretBody: true })
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
    const { q, agentId, all } = ModelsQuerySchema.parse(request.query)
    // The chosen-models list narrows the pickers; `all=1` is the picker's "Show all".
    const chosen = db && all !== '1' ? readChosenModels(db) : []
    const items = await port.listModels(q, chosen)
    const hiddenCount = chosen.length
      ? Math.max(0, (await port.listModels(q, undefined, Infinity)).length - items.length)
      : 0
    const rows = [...(await aliasRows(agentId, q)), ...items]
    return ModelsResponseSchema.parse({
      items: rows.filter((row, at) => rows.findIndex((r) => sameRow(r, row)) === at).slice(0, 200),
      ...(hiddenCount ? { hiddenCount } : {}),
    })
  })
  // An agent's aliases that match the search come first, so typing `fast` finds the model it stands for.
  async function aliasRows(
    agentId: string | undefined,
    q: string | undefined,
  ): Promise<ModelOption[]> {
    const needle = q?.trim().toLowerCase()
    if (!agentId || !needle) return []
    try {
      const matches = (await port.readModelSettings(agentId)).aliases.filter((alias) =>
        alias.name.includes(needle),
      )
      if (!matches.length) return []
      const known = await port.listModels(undefined)
      return matches.map((alias) => {
        // A providerless alias keeps the provider the agent already has: equal model names prove no routing identity.
        const target = alias.provider
          ? known.find((option) => option.model === alias.model && option.provider === alias.provider)
          : undefined
        const custom = !alias.editable
        return {
          // Never invent a provider: an unconfirmed one stays empty and the model route resolves the alias.
          provider: target?.provider ?? alias.provider ?? '',
          providerLabel: target?.providerLabel ?? alias.provider ?? 'Alias',
          model: alias.model,
          // Read-only: Score can't reproduce an alias's own endpoint or key per request.
          available: custom ? false : (target?.available ?? true),
          reason: custom ? CUSTOM_ALIAS_REASON : (target?.reason ?? null),
          free: target?.free ?? false,
          price: target?.price ?? null,
          ...(target?.contextLength === undefined ? {} : { contextLength: target.contextLength }),
          alias: alias.name,
        }
      })
    } catch {
      return []
    }
  }
  app.get('/api/settings/model-visibility', async () =>
    ModelVisibilitySchema.parse({ items: db ? readChosenModels(db) : [] }),
  )
  app.put('/api/settings/model-visibility', mutation, async (request) => {
    const { items } = ModelVisibilitySchema.parse(request.body)
    if (db) replaceChosenModels(db, items)
    return ModelVisibilitySchema.parse({ items: db ? readChosenModels(db) : [] })
  })
  app.post('/api/settings/providers/local', mutation, async (request) => {
    const req = LocalProviderRequestSchema.parse(request.body)
    return (await withUsage([await port.addLocalProvider(req)]))[0]
  })
  app.post('/api/settings/providers/:id/connect', mutation, async (request) => {
    const { id } = ProviderParamsSchema.parse(request.params)
    return port.connectProvider(id)
  })
  app.get('/api/settings/sign-ins/:signInId', async (request) =>
    port.getSignIn(SignInParamsSchema.parse(request.params).signInId),
  )
  app.delete('/api/settings/sign-ins/:signInId', mutation, async (request) =>
    port.cancelSignIn(SignInParamsSchema.parse(request.params).signInId),
  )
  // The key goes to `hermes auth add` on stdin and nowhere else: it is not logged, stored, echoed or put in a receipt.
  app.post(
    '/api/settings/providers/:id/key',
    {
      preHandler: [humanGuard(app.pairing), keyReceipts.preHandler],
      onSend: keyReceipts.onSend,
    },
    async (request) => {
      const { id } = ProviderParamsSchema.parse(request.params)
      const req = ProviderKeyRequestSchema.parse(request.body)
      return (await withUsage([await port.addProviderKey(id, req)]))[0]
    },
  )
  app.get('/api/settings/connections', async () => port.listConnections())
  app.post('/api/settings/tool-servers', mutation, async (request) =>
    port.addToolServer(ToolServerRequestSchema.parse(request.body)),
  )
  app.post('/api/settings/messaging/:platform/connect', mutation, async (request) => {
    const { platform } = z.object({ platform: PlatformParamSchema }).parse(request.params)
    return port.connectMessaging(platform)
  })
  app.get('/api/settings/messaging/:platform/fields', async (request) => {
    const { platform } = z.object({ platform: PlatformParamSchema }).parse(request.params)
    return MessagingFieldsResponseSchema.parse(await port.messagingFields(platform))
  })
  // Tokens go to `hermes config set` as argv and nowhere else: not logged, stored, echoed or put in a receipt.
  app.put(
    '/api/settings/messaging/:platform',
    {
      preHandler: [humanGuard(app.pairing), keyReceipts.preHandler],
      onSend: keyReceipts.onSend,
    },
    async (request) => {
      const { platform } = z.object({ platform: PlatformParamSchema }).parse(request.params)
      return port.saveMessaging(platform, MessagingSetupRequestSchema.parse(request.body))
    },
  )
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
