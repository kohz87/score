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
  /** How Connect works from the browser (ARCHITECTURE D2.7); absent = run in a terminal. */
  signIn: z.enum(['device_code', 'api_key', 'terminal']).optional(),
  /** Local providers only (2.0.10): whether an API key is set for it (never the key). */
  keySet: z.boolean().optional(),
})
export type ProviderItem = z.infer<typeof ProviderItemSchema>
export const ProvidersResponseSchema = z.object({ items: z.array(ProviderItemSchema) })
export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>

export const ConnectResultSchema = z.object({
  next: z.enum(['done', 'device_code', 'run_in_terminal', 'form']),
  command: z.string().optional(),
  url: z.string().optional(),
  code: z.string().optional(),
  signInId: z.string().optional(),
  expiresAt: z.iso.datetime().optional(),
})
export type ConnectResult = z.infer<typeof ConnectResultSchema>

export const SignInSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  state: z.enum(['waiting', 'connected', 'failed', 'expired', 'cancelled']),
  url: z.url({ protocol: /^https$/ }).nullable(),
  code: z.string().max(64).nullable(),
  expiresAt: z.iso.datetime(),
  message: z.string().nullable(),
})
export type SignIn = z.infer<typeof SignInSchema>

// The key goes to `hermes auth add` on stdin and nowhere else (D2.7): no whitespace, so it can't smuggle a second answer.
export const ProviderKeyRequestSchema = z
  .object({
    apiKey: z.string().regex(/^[\x21-\x7e]{8,512}$/),
    label: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/)
      .optional(),
  })
  .strict()
export type ProviderKeyRequest = z.infer<typeof ProviderKeyRequestSchema>

export const ModelOptionSchema = z.object({
  /** Empty only for an alias row whose provider is not confirmed (the server resolves the alias itself). */
  provider: z.string(),
  providerLabel: z.string().min(1),
  model: z.string().min(1).max(256),
  available: z.boolean(),
  reason: z.string().nullable(),
  free: z.boolean(),
  price: z.object({ input: z.string(), output: z.string() }).nullable(),
  /** Context window in tokens, when Hermes's model options carry it. */
  contextLength: z.int().positive().nullable().optional(),
  /** Set when the row stands for one of the agent's aliases that matched the search. */
  alias: z.string().optional(),
})
export type ModelOption = z.infer<typeof ModelOptionSchema>
export const ModelsQuerySchema = z.object({
  q: z.string().max(100).optional(),
  /** Whose aliases may match `q` (the agent being edited). */
  agentId: AgentIdSchema.optional(),
  /** "1" lists every model, ignoring the chosen-models list. */
  all: z.enum(['0', '1']).optional(),
})
export const ModelsResponseSchema = z.object({
  items: z.array(ModelOptionSchema).max(200),
  /** How many models the chosen-models list left out of `items`; absent when nothing was hidden. */
  hiddenCount: z.int().nonnegative().optional(),
})
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>

export const LocalProviderRequestSchema = z
  .object({
    label: NoDash.min(1).max(80),
    baseUrl: z.url({ protocol: /^https?$/ }).max(500),
    model: NoDash.min(1).max(200),
    /** Optional (2.0.10): written to every agent's Hermes profile, never stored, logged or echoed by Score. */
    apiKey: z
      .string()
      .regex(/^[\x21-\x7e]{1,512}$/)
      .optional(),
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

// Browser setup of a messaging platform (contract §10): field metadata comes from the server; values travel only in the
// PUT body and are never stored, logged or echoed.
export const MessagingFieldSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  label: z.string().min(1),
  help: z.string().nullable(),
  url: z.string().nullable(),
  secret: z.boolean(),
  required: z.boolean(),
})
export type MessagingField = z.infer<typeof MessagingFieldSchema>
export const MessagingFieldsResponseSchema = z.object({
  fields: z.array(MessagingFieldSchema),
  /** false = needs an interactive pairing in a terminal (QR codes and the like). */
  browserSetup: z.boolean(),
})
export type MessagingFieldsResponse = z.infer<typeof MessagingFieldsResponseSchema>
export const MessagingSetupRequestSchema = z
  .object({
    values: z.record(
      z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
      // One line, no leading dash (the value is a CLI argument).
      z
        .string()
        .max(2000)
        .refine((value) => !/[\0\r\n]/.test(value) && !value.trimStart().startsWith('-')),
    ),
    agentId: AgentIdSchema.optional(),
  })
  .strict()
export type MessagingSetupRequest = z.infer<typeof MessagingSetupRequestSchema>

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

// Contract §10 (Settings: plugins per profile). `locked` marks the Score bridge, which Score never disables.
export const PluginIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
export const PluginItemSchema = z.object({
  id: PluginIdSchema,
  label: z.string().min(1),
  enabled: z.boolean(),
  locked: z.boolean(),
  description: z.string().nullable(),
})
export type PluginItem = z.infer<typeof PluginItemSchema>
export const PluginsQuerySchema = z.object({ agent: AgentIdSchema }).strict()
export const PluginsResponseSchema = z.object({ items: z.array(PluginItemSchema) })
export type PluginsResponse = z.infer<typeof PluginsResponseSchema>
export const PatchPluginRequestSchema = z.object({ enabled: z.boolean() }).strict()
export type PatchPluginRequest = z.infer<typeof PatchPluginRequestSchema>
export const HermesCheckPartSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['same', 'added', 'changed', 'removed']),
  detail: z.string(),
})
export type HermesCheckPart = z.infer<typeof HermesCheckPartSchema>
export const HermesCheckSchema = z.object({
  /** sha256 over the build and parts; `accept` must send it back unchanged. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  build: z.object({
    version: z.string().nullable(),
    codeSha: z.string().nullable(),
    fingerprint: z.string(),
  }),
  parts: z.array(HermesCheckPartSchema),
  compatible: z.boolean(),
  /**
   * 3.14.4 (owner): an incompatible build the person may still turn approvals on for, with the security password: the
   * build is identified (a code revision) and Hermes still has the bridge hooks and the approval functions Score calls.
   */
  overridable: z.boolean().default(false),
})
export type HermesCheck = z.infer<typeof HermesCheckSchema>
export const HermesAcceptRequestSchema = z
  .object({
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    /** 3.14.4: turn approvals on anyway for an incompatible but overridable build; needs `password`. */
    override: z.literal(true).optional(),
    password: z.string().max(1024).optional(),
  })
  .strict()
export type HermesAcceptRequest = z.infer<typeof HermesAcceptRequestSchema>
export const HermesAcceptResponseSchema = z.object({ ok: z.literal(true) })
