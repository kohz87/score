import { ApprovalChoiceSchema, RunSummarySchema } from '@score/contract'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import { redact, redactValue } from '../../redact.ts'
import { CredentialsUnavailable, ensureGeneration, readKey } from './credentials.ts'
import { ProfileNameSchema } from './paths.ts'
import { connectSse, type SseConnection } from './sse-client.ts'

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
})
export type StartRun = z.infer<typeof StartRunSchema>
const AdmissionSchema = z.object({
  run_id: z.string().min(1),
  status: UpstreamStatusSchema,
  replayed: z.boolean(),
})
const ActionSchema = z
  .object({
    run_id: z.string().optional(),
    status: UpstreamStatusSchema.optional(),
    stopped: z.boolean().optional(),
    steered: z.boolean().optional(),
    accepted: z.boolean().optional(),
    ok: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0)
const CapabilitiesSchema = z
  .object({
    features: z.record(
      z.string(),
      z.union([z.boolean(), z.string(), z.record(z.string(), z.unknown())]),
    ),
  })
  .transform(({ features }) => features)
const HealthSchema = z.object({ status: z.string(), platform: z.string(), version: z.string() })
const errorCodes = z.enum([
  'approval_not_pending',
  'approval_not_active',
  // Hermes 0.22.5 (session authority): the answer was for an older execution generation of the run.
  'stale_generation',
  'gateway_auth_failed',
  'run_not_found',
  'invalid_request',
  'idempotency_conflict',
])

export class HermesHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly maybeApplied = true,
  ) {
    super(`Gateway request failed (${status}, ${code})`)
    this.name = 'HermesHttpError'
  }
}

export function redactRunPayload(value: unknown, secrets: string[] = []): Record<string, unknown> {
  const content = { ...z.record(z.string(), z.unknown()).parse(value) }
  const identifiers: Record<string, string | null> = {}
  for (const name of [
    'run_id',
    'request_id',
    'session_id',
    'session_key',
    'tool_call_id',
    'turn_id',
    'gate_id',
  ]) {
    if (!Object.hasOwn(content, name)) continue
    if (content[name] === null && name !== 'run_id' && name !== 'request_id') {
      identifiers[name] = null
      delete content[name]
      continue
    }
    const id = z
      .string()
      .regex(/^[\x21-\x7e]{1,256}$/)
      .parse(content[name])
    if (secrets.some((secret) => secret && id.includes(secret)))
      throw new HermesHttpError(200, 'invalid_response')
    identifiers[name] = id
    delete content[name]
  }
  return {
    ...z.record(z.string(), z.unknown()).parse(redactValue(content, secrets)),
    ...identifiers,
  }
}

/**
 * Streamed reply text (message.delta / message.interim) must reach the message layer unredacted: pattern redaction
 * per chunk destroys the context a secret split across chunks needs ("Authorization: Bearer " + token), and the
 * message layer redacts the joined text once it settles (domain/message-runs.ts). Only this profile's own gateway key
 * is stripped here; every other field gets the usual treatment.
 */
const STREAM_TEXT_FIELD: Record<string, string> = {
  'message.delta': 'delta',
  'message.interim': 'text',
}
export function redactRunFrame(
  event: string,
  value: unknown,
  secrets: string[] = [],
): Record<string, unknown> {
  const record = z.record(z.string(), z.unknown()).parse(value)
  // Hermes names the event inside the payload too (translate reads that one); the SSE event line is a fallback.
  const field = STREAM_TEXT_FIELD[typeof record.event === 'string' ? record.event : event]
  if (!field || typeof record[field] !== 'string') return redactRunPayload(record, secrets)
  const { [field]: text, ...rest } = record
  let raw = text as string
  for (const secret of secrets) if (secret) raw = raw.replaceAll(secret, '[redacted]')
  return { ...redactRunPayload(rest, secrets), [field]: raw }
}

export interface GatewayOptions {
  scoreHome: string
  db: ScoreDb
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}

const ModelOptionsSchema = z.object({
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

export class GatewayClient {
  private readonly baseUrl: string
  private readonly fetch: typeof globalThis.fetch
  constructor(private readonly options: GatewayOptions) {
    const url = new URL(options.baseUrl ?? 'http://127.0.0.1:8642')
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid gateway origin')
    this.baseUrl = url.origin
    this.fetch = options.fetch ?? globalThis.fetch
  }

  private url(profile: string, path: string): string {
    const name = ProfileNameSchema.parse(profile)
    return `${this.baseUrl}${name === 'default' ? '' : `/p/${name}`}${path}`
  }

  private credential(profile: string, generation?: number) {
    const credential = readKey(this.options.scoreHome, profile)
    const current = ensureGeneration(this.options.db, profile, credential.keySha256)
    if (generation !== undefined && generation !== current)
      throw new CredentialsUnavailable(profile)
    return { ...credential, generation: current }
  }

  generation(profile: string): number {
    return this.credential(profile).generation
  }

  withoutCredential(profile: string, text: string): string {
    return text.replaceAll(this.credential(profile).key, '[redacted]')
  }

  sanitize(profile: string, text: string): string {
    return redact(text.replaceAll(this.credential(profile).key, '[redacted]'))
  }

  private async json<T>(
    profile: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    idempotencyKey?: string,
    generation?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const key = path === '/v1/health' ? undefined : this.credential(profile, generation).key
    const headers = new Headers()
    if (key) headers.set('Authorization', `Bearer ${key}`)
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    if (idempotencyKey !== undefined)
      headers.set(
        'Idempotency-Key',
        z
          .string()
          .min(1)
          .regex(/^[\x21-\x7e]+$/)
          .parse(idempotencyKey),
      )
    let status = 0
    try {
      const response = await this.fetch(this.url(profile, path), {
        headers,
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      })
      status = response.status
      const text = await response.text()
      if (!response.ok) {
        let code = 'http_error'
        try {
          const value = z
            .object({ error: z.unknown().optional(), code: z.unknown().optional() })
            .parse(JSON.parse(text))
          const nested = z.object({ code: z.unknown().optional() }).safeParse(value.error)
          const parsed = errorCodes.safeParse(
            value.code ?? (nested.success ? nested.data.code : value.error),
          )
          if (parsed.success) code = parsed.data
        } catch {
          /* Error bodies never leave the client. */
        }
        throw new HermesHttpError(status, code)
      }
      return schema.parse(redactRunPayload(JSON.parse(text), key ? [key] : []))
    } catch (error) {
      if (error instanceof HermesHttpError) throw error
      const cause = z
        .object({ cause: z.object({ code: z.string().optional() }).optional() })
        .safeParse(error)
      const code = cause.success ? cause.data.cause?.code : undefined
      const notSent = [
        'ECONNREFUSED',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ERR_TLS_CERT_ALTNAME_INVALID',
        'CERT_HAS_EXPIRED',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      ].includes(code ?? '')
      throw new HermesHttpError(status, status ? 'invalid_response' : 'transport_error', !notSent)
    }
  }

  async startRun(
    request: StartRun,
    idempotencyKey: string,
    generation?: number,
    wireInput?: unknown,
  ) {
    const { profile, input, sessionId, model, provider } = StartRunSchema.parse(request)
    const result = await this.json(
      profile,
      '/v1/runs',
      AdmissionSchema,
      {
        input: wireInput ?? input,
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
        ...(model === undefined ? {} : { model }),
        ...(provider === undefined ? {} : { provider }),
      },
      idempotencyKey,
      generation,
    )
    return { runId: result.run_id, replayed: result.replayed }
  }

  getRun(
    profile: string,
    runId: string,
    generation?: number,
    signal?: AbortSignal,
  ): Promise<GatewayRun> {
    return this.json(
      profile,
      `/v1/runs/${encodeURIComponent(z.string().min(1).parse(runId))}`,
      GatewayRunSchema,
      undefined,
      undefined,
      generation,
      signal,
    )
  }
  async stopRun(profile: string, runId: string, generation?: number): Promise<void> {
    await this.json(
      profile,
      `/v1/runs/${encodeURIComponent(z.string().min(1).parse(runId))}/stop`,
      ActionSchema,
      {},
      undefined,
      generation,
    )
  }
  async steerRun(
    profile: string,
    runId: string,
    input: string,
    generation?: number,
  ): Promise<void> {
    await this.json(
      profile,
      `/v1/runs/${encodeURIComponent(z.string().min(1).parse(runId))}/steer`,
      ActionSchema,
      { input: z.string().min(1).parse(input) },
      undefined,
      generation,
    )
  }
  async submitApproval(
    profile: string,
    request: { runId: string; choice: z.infer<typeof ApprovalChoiceSchema>; requestId: string },
    generation?: number,
  ): Promise<'applied' | 'not_pending'> {
    const parsed = z
      .object({
        runId: z.string().min(1),
        choice: ApprovalChoiceSchema,
        requestId: z.string().min(1),
      })
      .parse(request)
    try {
      // Hermes 0.22.5 under its session authority answers only `{request_id, execution_generation, choice}` for the
      // run's current generation (api_server_authority_runs.py respond_run); its run projection says which. Older
      // builds and the non-authority path take `{choice, request_id}` and have no generation.
      // A projection that can't be read falls back to the older body; Hermes then refuses or applies it as usual.
      const projection = await this.json(
        profile,
        `/v1/runs/${encodeURIComponent(parsed.runId)}`,
        z.object({ execution_generation: z.int().nonnegative().optional() }).passthrough(),
        undefined,
        undefined,
        generation,
      ).catch(() => null)
      const body =
        projection?.execution_generation === undefined
          ? { choice: parsed.choice, request_id: parsed.requestId }
          : {
              request_id: parsed.requestId,
              execution_generation: projection.execution_generation,
              choice: parsed.choice,
            }
      const result = await this.json(
        profile,
        `/v1/runs/${encodeURIComponent(parsed.runId)}/approval`,
        z.union([
          z.object({ resolved: z.int().nonnegative() }),
          z.object({ status: z.enum(['resolved', 'already_resolved']) }).passthrough(),
        ]),
        body,
        undefined,
        generation,
      )
      if ('status' in result) return result.status === 'resolved' ? 'applied' : 'not_pending'
      if (result.resolved !== 1) throw new HermesHttpError(200, 'invalid_response')
      return 'applied'
    } catch (error) {
      if (
        error instanceof HermesHttpError &&
        error.status === 409 &&
        ['approval_not_pending', 'approval_not_active', 'stale_generation'].includes(error.code)
      )
        return 'not_pending'
      throw error
    }
  }
  capabilities(profile: string) {
    return this.json(profile, '/v1/capabilities', CapabilitiesSchema)
  }
  health() {
    return this.json('default', '/v1/health', HealthSchema)
  }
  /** The providers Hermes knows (slug + name); Settings lists them all, not a hard-coded few. */
  modelOptions(profile = 'default') {
    return this.json(profile, '/api/model/options', ModelOptionsSchema)
  }

  runEvents(
    profile: string,
    runId: string,
    lastEventId?: string,
    generation?: number,
    signal?: AbortSignal,
  ): SseConnection {
    const { key } = this.credential(profile, generation)
    const connection = connectSse({
      url: this.url(
        profile,
        `/v1/runs/${encodeURIComponent(z.string().min(1).parse(runId))}/events`,
      ),
      headers: { Authorization: `Bearer ${key}` },
      ...(lastEventId === undefined ? {} : { lastEventId }),
      ...(signal ? { signal } : {}),
      fetch: this.fetch,
    })
    return {
      closed: connection.closed,
      get retry() {
        return connection.retry
      },
      abort: () => connection.abort(),
      async *[Symbol.asyncIterator]() {
        for await (const frame of connection) {
          if (frame.type === 'comment') {
            yield frame
            continue
          }
          let value: unknown
          try {
            value = JSON.parse(frame.data)
          } catch {
            throw new HermesHttpError(200, 'invalid_response')
          }
          yield { ...frame, data: JSON.stringify(redactRunFrame(frame.event, value, [key])) }
        }
      },
    }
  }
}
