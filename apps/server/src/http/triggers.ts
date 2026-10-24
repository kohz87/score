import { randomUUID } from 'node:crypto'
import {
  TRIGGER_LIMITS,
  TriggerCreateRequestSchema,
  TriggerCreatedSchema,
  TriggerSecretSchema,
  TriggerSchema,
  TriggersResponseSchema,
  TriggerUpdateRequestSchema,
} from '@score/contract'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import type { Sealer } from '../auth/sealing.ts'
import type { ScoreDb } from '../db/index.ts'
import {
  createTrigger,
  deleteTrigger,
  listTriggers,
  receiveCall,
  verifyCall,
  rotateTrigger,
  triggerSecret,
  updateTrigger,
} from '../domain/triggers/triggers.ts'
import { startReportBack } from '../domain/triggers/report-back.ts'
import { jobEvent } from '../domain/exchanges/store.ts'
import { HOOK_PATH } from '../auth/remote.ts'
import { HttpError } from '../errors.ts'
import type { Ingest } from '../hub/ingest.ts'
import { RateLimiter } from '../shares/rate-limit.ts'

// Webhook triggers (PLAN 11.1d, contract "Triggers"). `POST /hooks/<id>` is the only route an outside app calls; in
// remote mode it is the only addition to the public list. Everything else is the person's, behind pairing.
export function registerTriggerRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    ingest: Ingest
    seal: Sealer
    /** The paired-browser guard for every change (no idempotency receipts: answers can hold the secret). */
    guard: { preHandler: preHandlerHookHandler[] }
    /** Where people and apps reach Score; null when only this machine can (local mode: the app needs a tunnel). */
    origin: string | null
    /** Starts the lead's turn the call queued. */
    redispatch: () => Promise<void>
    clock?: () => number
  },
): void {
  const { db, ingest, seal, guard, origin, redispatch } = deps
  const clock = deps.clock ?? Date.now
  const Params = z.object({ triggerId: z.string().min(1).max(64) })
  // Verified calls have their trigger's budget; failed ones are counted per caller, so a stranger who knows a trigger's
  // address can't use up the real sender's budget.
  const limiter = new RateLimiter(TRIGGER_LIMITS.callsPerMinute, 60_000, clock)
  const failures = new RateLimiter(TRIGGER_LIMITS.callsPerMinute, 60_000, clock)

  // The raw body is what is signed: parsed here as text, checked, then read as JSON.
  void app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers()
    hooks.addContentTypeParser(
      '*',
      { parseAs: 'string', bodyLimit: TRIGGER_LIMITS.bodyBytes },
      (_request, body, done) => done(null, body),
    )
    hooks.post('/hooks/:triggerId', async (request, reply) => {
      const { triggerId } = Params.parse(request.params)
      // A malformed id is answered before any lookup or queue.
      if (!HOOK_PATH.test(`/hooks/${triggerId}`))
        throw new HttpError(404, 'not_found', 'No such trigger.')
      const type = String(request.headers['content-type'] ?? '')
      if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(type))
        throw new HttpError(
          415,
          'not_json',
          'The body must be JSON (Content-Type: application/json).',
        )
      const header = (name: string) => {
        const value = request.headers[name]
        return typeof value === 'string' ? value : undefined
      }
      const signed = {
        id: header('webhook-id'),
        timestamp: header('webhook-timestamp'),
        signature: header('webhook-signature'),
      }
      const raw = typeof request.body === 'string' ? request.body : ''
      // Checked before anything is queued. A failed call counts against its caller, never against the trigger's own
      // budget, so a stranger who knows the address can't use it up.
      const caller = `${request.ip}:${triggerId}`
      try {
        db.read((sqlite) => verifyCall(sqlite, seal, triggerId, signed, raw, clock()))
      } catch (error) {
        if (!failures.allow(caller))
          throw new HttpError(429, 'rate_limited', 'Too many failed calls. Try again in a minute.')
        throw error
      }
      if (!limiter.allow(triggerId))
        throw new HttpError(
          429,
          'rate_limited',
          'Too many calls to this trigger. Try again in a minute.',
        )
      let answer: { jobId: string; repeated: boolean } | undefined
      await ingest.submit({
        source: 'triggers',
        identity: randomUUID(),
        apply: ({ sqlite }) => {
          const call = receiveCall(sqlite, seal, triggerId, signed, raw, clock())
          answer = call.result
          return call.drafts
        },
      })
      if (!answer?.repeated) await redispatch()
      return reply.code(200).send({ ok: true, jobId: answer?.jobId })
    })
  })

  app.get('/api/triggers', guard, async () =>
    TriggersResponseSchema.parse({ items: db.read((sqlite) => listTriggers(sqlite, origin)) }),
  )
  app.post('/api/triggers', guard, async (request, reply) => {
    const body = TriggerCreateRequestSchema.parse(request.body)
    const made = db.tx((sqlite) =>
      createTrigger(sqlite, seal, body, origin, new Date(clock()).toISOString()),
    )
    // The secret is shown in full here, once; later only to a paired browser (GET …/secret).
    return reply
      .code(201)
      .header('cache-control', 'no-store')
      .send(TriggerCreatedSchema.parse(made))
  })
  app.patch('/api/triggers/:triggerId', guard, async (request) => {
    const { triggerId } = Params.parse(request.params)
    const body = TriggerUpdateRequestSchema.parse(request.body)
    return TriggerSchema.parse(
      db.tx((sqlite) =>
        updateTrigger(sqlite, triggerId, body, origin, new Date(clock()).toISOString()),
      ),
    )
  })
  app.delete('/api/triggers/:triggerId', guard, async (request, reply) => {
    const { triggerId } = Params.parse(request.params)
    db.tx((sqlite) => deleteTrigger(sqlite, triggerId, new Date(clock()).toISOString()))
    return reply.code(204).send()
  })
  // A trigger-started job's report-back: the person's "Send the result back" and Try again.
  app.post('/api/jobs/:jobId/report-back', guard, async (request) => {
    const { jobId } = z.object({ jobId: z.string().min(1).max(64) }).parse(request.params)
    await ingest.submit({
      source: 'triggers',
      identity: randomUUID(),
      apply: ({ sqlite }) => {
        startReportBack(sqlite, jobId, new Date(clock()).toISOString())
        return jobEvent(sqlite, jobId)
      },
    })
    await redispatch()
    return { ok: true }
  })
  app.get('/api/triggers/:triggerId/secret', guard, async (request, reply) => {
    void reply.header('cache-control', 'no-store')
    const { triggerId } = Params.parse(request.params)
    return TriggerSecretSchema.parse({
      secret: db.read((sqlite) => triggerSecret(sqlite, seal, triggerId)),
    })
  })
  app.post('/api/triggers/:triggerId/rotate', guard, async (request, reply) => {
    void reply.header('cache-control', 'no-store')
    const { triggerId } = Params.parse(request.params)
    return TriggerSecretSchema.parse({
      secret: db.tx((sqlite) =>
        rotateTrigger(sqlite, seal, triggerId, new Date(clock()).toISOString()),
      ),
    })
  })
}
