import { RunSummarySchema } from '@score/contract'
import { z } from 'zod'
import { ProfileNameSchema } from './paths.ts'

export const RunStatusSchema = RunSummarySchema.shape.status
const UpstreamStatusSchema = z
  .union([RunStatusSchema, z.literal('started'), z.literal('stopping')])
  .transform((status) =>
    status === 'started' || status === 'stopping' ? ('running' as const) : status,
  )
export const UsageSchema = z.object({
  input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
  cost_usd: z.number().finite().nonnegative().nullish(),
})
const TimestampSchema = z
  .union([z.number().finite().nonnegative(), z.iso.datetime()])
  .transform((value) => (typeof value === 'number' ? new Date(value * 1000).toISOString() : value))
export const GatewayRunSchema = z.object({
  run_id: z.string().min(1),
  status: UpstreamStatusSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  session_id: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  model: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  output: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  error: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  last_event: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  usage: UsageSchema.nullish(),
  // The pending approval.request while the run waits (api_server_runs `_set_run_status`); validated by the consumer.
  approval: z.unknown().optional(),
})
export type GatewayRun = z.infer<typeof GatewayRunSchema>
export const StartRunSchema = z.object({
  profile: ProfileNameSchema,
  input: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  // Media ids only: bytes are read when the request is sent (never stored in the intent).
  images: z.array(z.string().min(1)).max(16).optional(),
  /**
   * Hermes' per-run extra system prompt. Frozen in the intent when it is created: Hermes fingerprints the whole body for
   * the idempotency key, so a start recovered after an upgrade must send what it first sent.
   */
  instructions: z.string().min(1).optional(),
})
export type StartRun = z.infer<typeof StartRunSchema>

/**
 * 3.7.11 (decision 141): Hermes tells a model on its API server that "the rendering layer is unknown — assume plain text.
 * No markdown". Score renders GitHub Markdown, so every run carries this as its extra system prompt (`instructions`,
 * which Hermes appends after its own, so it wins). Set on each new run intent (intents.ts).
 */
export const SCORE_RENDERING_NOTE =
  '[Score] Your replies are shown in Score, which renders GitHub-flavoured Markdown. Use headings, lists, bold, code blocks and tables where they help. A table needs a header row, then a separator row such as | --- | --- |. This replaces any instruction to answer in plain text.'
export const AdmissionSchema = z.object({
  run_id: z.string().min(1),
  status: UpstreamStatusSchema,
  replayed: z.boolean(),
})
export const ActionSchema = z
  .object({
    run_id: z.string().optional(),
    status: UpstreamStatusSchema.optional(),
    stopped: z.boolean().optional(),
    steered: z.boolean().optional(),
    accepted: z.boolean().optional(),
    ok: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0)
export const CapabilitiesSchema = z
  .object({
    features: z.record(
      z.string(),
      z.union([z.boolean(), z.string(), z.record(z.string(), z.unknown())]),
    ),
  })
  .transform(({ features }) => features)
export const HealthSchema = z.object({
  status: z.string(),
  platform: z.string(),
  version: z.string(),
})
export const errorCodes = z.enum([
  'approval_not_pending',
  'approval_not_active',
  // Hermes 0.22.5 (session authority): the answer was for an older execution generation of the run.
  'stale_generation',
  'invalid_params',
  // 0.22.5: a session id that was deleted can never be used again (decision 128).
  'session_deleted',
  'gateway_auth_failed',
  'run_not_found',
  'invalid_request',
  'idempotency_conflict',
])

export const ModelOptionsSchema = z.object({
  providers: z
    .array(
      z
        .object({
          slug: z.string().min(1).max(64),
          name: z.string().min(1).max(120),
          // How Hermes authenticates the provider (inventory.py `_provider_auth_hint`): "api_key", "oauth_device_code", …
          auth_type: z.string().max(64).optional(),
          authenticated: z.boolean().optional(),
          models: z.array(z.string().min(1).max(256)).max(2000).optional(),
          unavailable_models: z.array(z.string().max(256)).max(2000).optional(),
          pricing: z
            .record(
              z.string().max(256),
              z
                .object({
                  input: z.unknown().optional(),
                  output: z.unknown().optional(),
                  free: z.unknown().optional(),
                })
                .loose(),
            )
            .optional(),
        })
        .loose(),
    )
    .max(500),
})
