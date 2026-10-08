import { z } from 'zod'
import { AgentIdSchema } from './types.ts'

// Contract §10 (Settings: providers and connections). Status only: no secret ever crosses this boundary.
const NoNul = z.string().refine((value) => !value.includes('\0'))
// Values travel as CLI arguments: a leading dash would be read as a flag.
const NoDash = NoNul.refine((value) => !value.trimStart().startsWith('-'))

export const ProviderItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['connected', 'needs_signin', 'missing']),
  detail: z.string(),
  usedBy: z.array(AgentIdSchema),
})
export type ProviderItem = z.infer<typeof ProviderItemSchema>
export const ProvidersResponseSchema = z.object({ items: z.array(ProviderItemSchema) })
export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>

export const ConnectResultSchema = z.object({
  next: z.enum(['done', 'device_code', 'run_in_terminal']),
  command: z.string().optional(),
  url: z.string().optional(),
  code: z.string().optional(),
})
export type ConnectResult = z.infer<typeof ConnectResultSchema>

export const LocalProviderRequestSchema = z
  .object({
    label: NoDash.min(1).max(80),
    baseUrl: z.url({ protocol: /^https?$/ }).max(500),
    model: NoDash.min(1).max(200),
  })
  .strict()
export type LocalProviderRequest = z.infer<typeof LocalProviderRequestSchema>

export const ToolServerSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['ok', 'needs_signin', 'error']),
  usedBy: z.union([z.literal('everyone'), z.array(AgentIdSchema)]),
})
export type ToolServer = z.infer<typeof ToolServerSchema>
export const MessagingPlatformSchema = z.object({
  platform: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['connected', 'disconnected']),
  detail: z.string().nullable(),
})
export type MessagingPlatform = z.infer<typeof MessagingPlatformSchema>
export const ConnectionsResponseSchema = z.object({
  toolServers: z.array(ToolServerSchema),
  messaging: z.array(MessagingPlatformSchema),
})
export type ConnectionsResponse = z.infer<typeof ConnectionsResponseSchema>

export const ToolServerRequestSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    command: z
      .array(NoNul.min(1).max(1000))
      .min(1)
      .max(50)
      .refine((parts) => !parts[0]!.startsWith('-'))
      .optional(),
    url: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .optional(),
  })
  .strict()
  .refine((value) => (value.command === undefined) !== (value.url === undefined))
export type ToolServerRequest = z.infer<typeof ToolServerRequestSchema>
export const PlatformParamSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)

// Contract §10 (Settings: advanced config). Secret-bearing and env-backed keys never appear here: the server
// leaves them out of search and refuses to write them.
export const ConfigKeySchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}(\.[A-Za-z0-9_-]{1,64}){0,11}$/)
  .max(256)
export const ConfigItemSchema = z.object({
  key: ConfigKeySchema,
  value: z.unknown(),
  file: z.string(),
  description: z.string().nullable(),
})
export type ConfigItem = z.infer<typeof ConfigItemSchema>
export const ConfigSearchQuerySchema = z.object({ q: z.string().max(200).default('') }).strict()
export const ConfigSearchResponseSchema = z.object({ items: z.array(ConfigItemSchema).max(50) })
export type ConfigSearchResponse = z.infer<typeof ConfigSearchResponseSchema>

const ConfigValueSchema = z.json().refine((value) => JSON.stringify(value).length <= 10_000)
export const ConfigChangeSchema = z
  .object({ key: ConfigKeySchema, value: ConfigValueSchema })
  .strict()
export type ConfigChange = z.infer<typeof ConfigChangeSchema>
const ConfigChangesSchema = z
  .array(ConfigChangeSchema)
  .min(1)
  .max(50)
  .refine((changes) => new Set(changes.map((change) => change.key)).size === changes.length)
export const ConfigPreviewRequestSchema = z.object({ changes: ConfigChangesSchema }).strict()
export type ConfigPreviewRequest = z.infer<typeof ConfigPreviewRequestSchema>
export const ConfigPreviewResponseSchema = z.object({
  diff: z.string(),
  file: z.string(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
})
export type ConfigPreviewResponse = z.infer<typeof ConfigPreviewResponseSchema>
export const ConfigApplyRequestSchema = z
  .object({
    changes: ConfigChangesSchema,
    expectedDiffHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
export type ConfigApplyRequest = z.infer<typeof ConfigApplyRequestSchema>
export const ConfigApplyResponseSchema = z.object({
  ok: z.literal(true),
  restartRequired: z.boolean(),
})
export type ConfigApplyResponse = z.infer<typeof ConfigApplyResponseSchema>
