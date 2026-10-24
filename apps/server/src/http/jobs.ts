import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ExchangeDecisionRequestSchema,
  ExchangesResponseSchema,
  JobCreateRequestSchema,
  JobSchema,
  JobsResponseSchema,
} from '@score/contract'
import type { FastifyInstance, preHandlerHookHandler, onSendHookHandler } from 'fastify'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { decideExchange, stopJob, type Decided } from '../domain/exchanges/decisions.ts'
import { createJob, jobRow, listExchanges, listJobs } from '../domain/exchanges/store.ts'
import type { HermesPort } from '../hermes/index.ts'
import { roomRow } from '../domain/rooms.ts'
import { HttpError } from '../errors.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'

// Jobs and their exchanges (contract §5 "Jobs", PLAN 11.1b).
export function registerJobRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    ingest: Ingest
    port: HermesPort
    mutation: { preHandler: preHandlerHookHandler[]; onSend: onSendHookHandler }
    /** Starts the turns a decision queued. */
    redispatch: () => Promise<void>
  },
): void {
  const { db, ingest, port, mutation, redispatch } = deps
  const ExchangeParams = z.object({ exchangeId: z.string().min(1).max(64) })

  /** Applies a decision in one transaction, then stops what was running and starts what was queued. */
  async function decide(apply: (sqlite: DatabaseSync, now: string) => Decided) {
    let running: Decided['running'] = []
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        const decided = apply(sqlite, now)
        running = decided.running
        return decided.drafts
      },
    })
    // A run that won't stop is reported by its own completion; the exchange is already stopped.
    await Promise.allSettled(running.map((run) => port.stopRun(run)))
    await redispatch()
  }

  // PLAN 11.1c: the person's answer to a paused or stuck exchange, and a job's Stop.
  app.post('/api/exchanges/:exchangeId/decision', mutation, async (request) => {
    const { exchangeId } = ExchangeParams.parse(request.params)
    const body = ExchangeDecisionRequestSchema.parse(request.body)
    await decide((sqlite, now) => decideExchange(sqlite, exchangeId, body, now))
    return { ok: true }
  })
  app.post('/api/jobs/:jobId/stop', mutation, async (request) => {
    const { jobId } = z.object({ jobId: z.string().min(1).max(64) }).parse(request.params)
    await decide((sqlite, now) => stopJob(sqlite, jobId, now))
    return { ok: true }
  })
  const RoomParams = z.object({ roomId: z.string().min(1).max(256) })
  const JobParams = z.object({ jobId: z.string().min(1).max(64) })

  app.get('/api/rooms/:roomId/jobs', async (request) => {
    const { roomId } = RoomParams.parse(request.params)
    const result = snapshot(db, (sqlite) => {
      roomRow(sqlite, roomId)
      return listJobs(sqlite, roomId)
    })
    return JobsResponseSchema.parse({ asOfSeq: result.asOfSeq, items: result.data })
  })

  app.post('/api/rooms/:roomId/jobs', mutation, async (request, reply) => {
    const { roomId } = RoomParams.parse(request.params)
    const body = JobCreateRequestSchema.parse(request.body)
    let created: unknown
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        const made = createJob(sqlite, roomId, body.title, now)
        created = made.job
        return made.drafts
      },
    })
    return reply.code(201).send(JobSchema.parse(created))
  })

  app.get('/api/jobs/:jobId/exchanges', async (request) => {
    const { jobId } = JobParams.parse(request.params)
    const result = snapshot(db, (sqlite) => {
      if (!jobRow(sqlite, jobId)) throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
      return listExchanges(sqlite, jobId)
    })
    return ExchangesResponseSchema.parse({ asOfSeq: result.asOfSeq, items: result.data })
  })
}
