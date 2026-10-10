import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import type { ObservationSink } from '../port.ts'
import { CredentialsUnavailable } from './credentials.ts'
import { GatewayClient, HermesHttpError, StartRunSchema, type StartRun } from './gateway.ts'
import { attachRunMessage, isCancelledTurn } from '../../domain/message-runs.ts'
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
  stop_state: z.enum(['pending', 'done']).nullable(),
})
/** Orchestration dispatches (PLAN 7.5): `render` fills in the per-turn capability for the wire payload only. */
export interface RunIntentOptions {
  owner?: 'orchestration'
  render?: (stored: string) => string
}
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

  async startRunIntent(
    request: StartRun,
    turnId: string,
    options: RunIntentOptions = {},
  ): Promise<{ runId: string }> {
    const safe = parseRequest(this.deps.gateway, request)
    const fingerprint = JSON.stringify(safe)
    const pending = this.flights.get(turnId)
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        return Promise.reject(new Error('Idempotency key belongs to a different request'))
      return pending.promise
    }
    const work = startRunIntent(this.deps, safe, turnId, options).finally(() =>
      this.flights.delete(turnId),
    )
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
  render?: (stored: string) => string,
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
          : render
            ? render(payload.input)
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
          // Rebuilding the row after a crash must keep the real start: crash recovery only trusts Hermes history
          // written after it.
          row.first_sent_at ?? now,
          now,
        )
      return [
        ...(inserted.changes ? [runDraft(sqlite, id)] : []),
        ...attachRunMessage(sqlite, row.idempotency_key, id, now),
      ]
    },
  })
  // The reply was cancelled while Hermes admitted it: stop the run instead of letting it answer a deleted message.
  // Read after the (possibly deduplicated) admission, so a retry sees the cancellation too.
  if (row.stop_state !== 'done' && isCancelledTurn(db.sqlite, row.idempotency_key))
    await stopCancelledRun(deps, row.id, payload.profile, id, payload.credentialGeneration)
  return { runId: id }
}

/** Stops the run of a cancelled reply. The stop is recorded as owed first and retried (by recovery and by a repeated
 *  admission) until Hermes confirms; a failure is not the caller's error, the reply is gone anyway. */
async function stopCancelledRun(
  deps: IntentDeps,
  intentId: string,
  profile: string,
  runId: string,
  generation: number,
): Promise<void> {
  const { db, gateway } = deps
  db.sqlite
    .prepare(
      "UPDATE command_intents SET stop_state = 'pending' WHERE id = ? AND stop_state IS NULL",
    )
    .run(intentId)
  try {
    await gateway.stopRun(profile, runId, generation)
  } catch (error) {
    // Hermes no longer knows the run: it is over.
    if (!(error instanceof HermesHttpError && error.status === 404)) return
  }
  db.sqlite.prepare("UPDATE command_intents SET stop_state = 'done' WHERE id = ?").run(intentId)
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
  options: RunIntentOptions = {},
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
      payload.provider !== parsed.provider ||
      payload.sessionId !== parsed.sessionId ||
      JSON.stringify(payload.images ?? []) !== JSON.stringify(parsed.images ?? [])
    )
      throw new Error('Idempotency key belongs to a different request')
    return dispatch(deps, row, options.render)
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
        `INSERT INTO command_intents (id, kind, idempotency_key, payload, state, owner, created_at, updated_at) VALUES (?, 'start_run', ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(id, turnId, JSON.stringify(payload), options.owner ?? null, now, now)
  })
  return dispatch(
    deps,
    IntentRowSchema.parse(
      deps.db.sqlite.prepare('SELECT * FROM command_intents WHERE id = ?').get(id),
    ),
    options.render,
  )
}

export async function recoverIntents(deps: IntentDeps): Promise<void> {
  const rows = z
    .array(IntentRowSchema)
    .parse(
      deps.db.sqlite
        .prepare(
          `SELECT * FROM command_intents WHERE kind = 'start_run' AND owner IS NULL AND (state IN ('pending','sent','unknown') OR (state = 'accepted' AND (NOT EXISTS (SELECT 1 FROM runs WHERE runs.score_turn_id = command_intents.idempotency_key) OR (stop_state IS NOT 'done' AND EXISTS (SELECT 1 FROM message_runs mr WHERE mr.turn_id = command_intents.idempotency_key AND mr.run_id IS NULL AND mr.state != 'pending'))))) ORDER BY created_at, id`,
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
