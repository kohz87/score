import { ApprovalChoiceSchema } from '@score/contract'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import { redact } from '../../redact.ts'
import { CredentialsUnavailable, ensureGeneration, readKey } from './credentials.ts'
import { HermesHttpError } from './gateway-errors.ts'
import { redactRunFrame, redactRunPayload } from './gateway-redaction.ts'
import {
  ActionSchema,
  AdmissionSchema,
  CapabilitiesSchema,
  errorCodes,
  GatewayRunSchema,
  HealthSchema,
  ModelOptionsSchema,
  StartRunSchema,
  type GatewayRun,
  type StartRun,
} from './gateway-schemas.ts'
import { ProfileNameSchema } from './paths.ts'
import { connectSse, type SseConnection } from './sse-client.ts'

export interface GatewayOptions {
  scoreHome: string
  db: ScoreDb
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}

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
    const { profile, input, sessionId, model, provider, instructions, effort } =
      StartRunSchema.parse(request)
    const result = await this.json(
      profile,
      '/v1/runs',
      AdmissionSchema,
      {
        input: wireInput ?? input,
        ...(instructions === undefined ? {} : { instructions }),
        ...(sessionId === undefined ? {} : { session_id: sessionId }),
        ...(model === undefined ? {} : { model }),
        ...(provider === undefined ? {} : { provider }),
        ...(effort === undefined ? {} : { model_options: { reasoning_effort: effort } }),
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
  /**
   * Answers a clarify question (decision 128): `{request_id, execution_generation, answer}`, the generation the
   * question was asked in (or the run's current one). `not_pending` when Hermes no longer waits for it.
   */
  async submitClarify(
    profile: string,
    request: { runId: string; promptId: string; generation: number | null; answer: string },
    credentialGeneration?: number,
  ): Promise<'applied' | 'not_pending'> {
    const parsed = z
      .object({
        runId: z.string().min(1),
        promptId: z.string().min(1),
        generation: z.int().nonnegative().nullable(),
        answer: z.string().min(1).max(16384),
      })
      .parse(request)
    try {
      const executionGeneration =
        parsed.generation ??
        (
          await this.json(
            profile,
            `/v1/runs/${encodeURIComponent(parsed.runId)}`,
            z.object({ execution_generation: z.int().nonnegative() }).passthrough(),
            undefined,
            undefined,
            credentialGeneration,
          )
        ).execution_generation
      const result = await this.json(
        profile,
        `/v1/runs/${encodeURIComponent(parsed.runId)}/clarify`,
        z.object({ status: z.enum(['resolved', 'already_resolved']) }).passthrough(),
        {
          request_id: parsed.promptId,
          execution_generation: executionGeneration,
          answer: parsed.answer,
        },
        undefined,
        credentialGeneration,
      )
      return result.status === 'resolved' ? 'applied' : 'not_pending'
    } catch (error) {
      if (
        error instanceof HermesHttpError &&
        (error.status === 404 ||
          (error.status === 409 &&
            ['approval_not_pending', 'stale_generation', 'run_not_found'].includes(error.code)))
      )
        return 'not_pending'
      throw error
    }
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
      // Only a run Hermes doesn't project (404) or a projection Score can't read falls back to the older body; a
      // transient failure (timeout, 5xx, 429) is thrown as it is, so the answer stays retryable instead of being sent
      // in a shape the authority refuses for good.
      const projection = await this.json(
        profile,
        `/v1/runs/${encodeURIComponent(parsed.runId)}`,
        z.object({ execution_generation: z.int().nonnegative().optional() }).passthrough(),
        undefined,
        undefined,
        generation,
      ).catch((error: unknown) => {
        if (error instanceof z.ZodError) return null
        if (error instanceof HermesHttpError && error.status === 404) return null
        throw error
      })
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
