import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import type { ObservationSink } from '../port.ts'
import { CredentialsUnavailable } from './credentials.ts'
import { GatewayClient, HermesHttpError, StartRunSchema, type StartRun } from './gateway.ts'
import { attachRunMessage } from '../../domain/message-runs.ts'
import { assertAgentAdmits } from '../../domain/agent-lifecycle.ts'
import { runDraft } from './translate.ts'
import { HttpError } from '../../errors.ts'
import type { ImageReader } from '../port.ts'
import { buildRunInput } from './attachments.ts'

const PayloadSchema = StartRunSchema.extend({ credentialGeneration: z.int().positive() })
const IntentRowSchema = z.object({
  id: z.string(),
  kind: z.literal('start_run'),
  idempotency_key: z.string(),
  payload: z.string(),
  state: z.enum(['pending', 'sent', 'accepted', 'failed', 'unknown']),
  result: z.string().nullable(),
  first_sent_at: z.iso.datetime().nullable(),
})
interface IntentDeps {
  db: ScoreDb
  gateway: GatewayClient
  sink: ObservationSink
  imageReader?: ImageReader
}

export class RunIntents {
  private readonly flights = new Map<
    string,
    { fingerprint: string; promise: Promise<{ runId: string }> }
  >()
  constructor(private readonly deps: IntentDeps) {}

  async startRunIntent(request: StartRun, turnId: string): Promise<{ runId: string }> {
    const safe = parseRequest(this.deps.gateway, request)
    const fingerprint = JSON.stringify(safe)
    const pending = this.flights.get(turnId)
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        return Promise.reject(new Error('Idempotency key belongs to a different request'))
      return pending.promise
    }
    const work = startRunIntent(this.deps, safe, turnId).finally(() => this.flights.delete(turnId))
    this.flights.set(turnId, { fingerprint, promise: work })
    return work
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.flights.values()].map(({ promise }) => promise))
  }
  recoverIntents(): Promise<void> {
    return recoverIntents(this.deps)
  }
}

async function dispatch(
  deps: IntentDeps,
  row: z.infer<typeof IntentRowSchema>,
): Promise<{ runId: string }> {
  const { db, gateway, sink } = deps
  const payload = PayloadSchema.parse(JSON.parse(row.payload))
  let runId = row.result
  if (row.state !== 'accepted') {
    assertAgentAdmits(db.sqlite, payload.profile)
    // Typed so routing fails the turn instead of replaying this refusal forever.
    if (row.state === 'failed')
      throw new HttpError(422, 'admission_refused', 'Hermes refused this run earlier')
    if (
      ['sent', 'unknown'].includes(row.state) &&
      (row.first_sent_at === null ||
        Date.now() - Date.parse(row.first_sent_at) >= 23 * 60 * 60 * 1000)
    ) {
      db.sqlite
        .prepare(
          "UPDATE command_intents SET state = 'unknown', last_error = 'replay_window_passed', updated_at = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), row.id)
      throw new HermesHttpError(0, 'replay_window_passed')
    }
    db.tx((sqlite) => {
      sqlite
        .prepare(
          `UPDATE command_intents SET state = 'sent', attempts = attempts + 1, first_sent_at = COALESCE(first_sent_at, ?), updated_at = ? WHERE id = ?`,
        )
        .run(new Date().toISOString(), new Date().toISOString(), row.id)
    })
    try {
      const result = await gateway.startRun(
        payload,
        row.idempotency_key,
        payload.credentialGeneration,
        payload.images?.length
          ? buildRunInput(payload.input, payload.images, deps.imageReader)
          : undefined,
      )
      runId = result.runId
      db.tx((sqlite) => {
        sqlite
          .prepare(
            `UPDATE command_intents SET state = 'accepted', result = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(runId, new Date().toISOString(), row.id)
      })
    } catch (error) {
      const definite =
        error instanceof HermesHttpError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      db.tx((sqlite) => {
        sqlite
          .prepare(
            'UPDATE command_intents SET state = ?, last_error = ?, updated_at = ? WHERE id = ?',
          )
          .run(
            definite ? 'failed' : 'unknown',
            error instanceof CredentialsUnavailable
              ? 'credentials_unavailable'
              : 'admission_failed',
            new Date().toISOString(),
            row.id,
          )
      })
      throw error
    }
  }
  const id = z.string().min(1).parse(runId)
  await sink.submit({
    source: 'score-dispatch',
    identity: `admitted:${row.id}`,
    apply({ sqlite, now }) {
      const inserted = sqlite
        .prepare(
          `INSERT INTO runs (id, profile, origin, score_turn_id, credential_generation, session_id, status, model, started_at, updated_at)
      VALUES (?, ?, 'score', ?, ?, ?, 'queued', ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          id,
          payload.profile,
          row.idempotency_key,
          payload.credentialGeneration,
          payload.sessionId ?? null,
          payload.model ?? null,
          now,
          now,
        )
      return [
        ...(inserted.changes ? [runDraft(sqlite, id)] : []),
        ...attachRunMessage(sqlite, row.idempotency_key, id, now),
      ]
    },
  })
  return { runId: id }
}

// The user's message reaches the agent unchanged: generic redaction (D6) is for data coming out of
// Hermes, not for what the user asked. The one exception is this profile's own gateway key, which is
// never meaningful in a prompt and must never reach a model or Score's DB.
function parseRequest(gateway: GatewayClient, request: StartRun): StartRun {
  const parsed = StartRunSchema.parse(request)
  return { ...parsed, input: gateway.withoutCredential(parsed.profile, parsed.input) }
}

export async function startRunIntent(
  deps: IntentDeps,
  request: StartRun,
  turnId: string,
): Promise<{ runId: string }> {
  const parsed = parseRequest(deps.gateway, request)
  z.string()
    .min(1)
    .regex(/^[\x21-\x7e]+$/)
    .parse(turnId)
  if (deps.gateway.sanitize(parsed.profile, turnId) !== turnId)
    throw new Error('Idempotency key contains sensitive data')
  const existing = deps.db.sqlite
    .prepare('SELECT * FROM command_intents WHERE idempotency_key = ?')
    .get(turnId)
  if (existing !== undefined) {
    const row = IntentRowSchema.parse(existing)
    const payload = PayloadSchema.parse(JSON.parse(row.payload))
    if (
      payload.profile !== parsed.profile ||
      payload.input !== parsed.input ||
      payload.model !== parsed.model ||
      payload.sessionId !== parsed.sessionId ||
      JSON.stringify(payload.images ?? []) !== JSON.stringify(parsed.images ?? [])
    )
      throw new Error('Idempotency key belongs to a different request')
    return dispatch(deps, row)
  }
  const credentialGeneration = deps.gateway.generation(parsed.profile)
  const active = z
    .object({ count: z.int().nonnegative() })
    .parse(
      deps.db.sqlite
        .prepare(
          `SELECT count(*) AS count FROM runs WHERE profile = ? AND status IN ('queued','running','waiting_for_approval') AND credential_generation != ?`,
        )
        .get(parsed.profile, credentialGeneration),
    )
  if (active.count) throw new CredentialsUnavailable(parsed.profile)
  const payload = PayloadSchema.parse({
    ...parsed,
    credentialGeneration,
  })
  const id = randomUUID()
  deps.db.tx((sqlite) => {
    const now = new Date().toISOString()
    sqlite
      .prepare(
        `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, created_at, updated_at) VALUES (?, 'start_run', ?, ?, 'pending', ?, ?)`,
      )
      .run(id, turnId, JSON.stringify(payload), now, now)
  })
  return dispatch(
    deps,
    IntentRowSchema.parse(
      deps.db.sqlite.prepare('SELECT * FROM command_intents WHERE id = ?').get(id),
    ),
  )
}

export async function recoverIntents(deps: IntentDeps): Promise<void> {
  const rows = z
    .array(IntentRowSchema)
    .parse(
      deps.db.sqlite
        .prepare(
          `SELECT * FROM command_intents WHERE kind = 'start_run' AND (state IN ('pending','sent','unknown') OR (state = 'accepted' AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.score_turn_id = command_intents.idempotency_key))) ORDER BY created_at, id`,
        )
        .all(),
    )
  for (const row of rows) {
    try {
      await dispatch(deps, row)
    } catch (error) {
      // Leave uncertain admissions durable and continue recovering other profiles.
      if (!(error instanceof CredentialsUnavailable || error instanceof HermesHttpError))
        throw error
    }
  }
}
