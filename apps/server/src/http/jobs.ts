import { randomUUID } from 'node:crypto'
import {
  ExchangesResponseSchema,
  JobCreateRequestSchema,
  JobSchema,
  JobsResponseSchema,
} from '@score/contract'
import type { FastifyInstance, preHandlerHookHandler, onSendHookHandler } from 'fastify'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { createJob, jobRow, listExchanges, listJobs } from '../domain/exchanges/store.ts'
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
    mutation: { preHandler: preHandlerHookHandler[]; onSend: onSendHookHandler }
  },
): void {
  const { db, ingest, mutation } = deps
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
