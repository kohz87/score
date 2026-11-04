import { randomUUID } from 'node:crypto'
import { JobSchema, RoomQueueResponseSchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { endJob } from '../domain/exchanges/decisions.ts'
import { jobDeleted } from '../domain/exchanges/job-life.ts'
import { jobFromRow, jobRow } from '../domain/exchanges/store.ts'
import type { Orchestrator } from '../domain/orchestration/executor.ts'
import { roomRow } from '../domain/rooms.ts'
import { hasQueued, listQueue, skipQueued, startQueued } from '../domain/triggers/queue.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'
import { requestIdempotency } from './idempotency.ts'

// 3.28.0 (decision 164, contract "One job per chat"): a group chat's Stop job, and its queue of trigger calls that wait
// for the running job to end (Next up).
export function registerOneJobRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    ingest: Ingest
    port: HermesPort
    /** Starts the lead turns a started queue item reserved. */
    dispatch: () => Promise<void>
    orchestrator?: Orchestrator
    clock?: () => number
  },
): void {
  const { db, ingest, port, dispatch, orchestrator } = deps
  const receipts = requestIdempotency(db, deps.clock)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }
  const JobParams = z.object({ jobId: z.string().min(1).max(64) })
  const RoomParams = z.object({ roomId: z.string().min(1).max(256) })
  const QueueParams = RoomParams.extend({ itemId: z.string().min(1).max(64) })

  /** A run's job ends with its run: the run is stopped first (its own fence and drain), then the job closes. */
  async function stopRecipe(jobId: string) {
    const row = db.read((sqlite) => jobRow(sqlite, jobId))
    // Refused before anything stops: a deleted job, or the room's own thread (review).
    if (!row || db.read((sqlite) => jobDeleted(sqlite, jobId)))
      throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
    if (row.is_default)
      throw new HttpError(
        409,
        'conflict',
        'The room’s own thread follows the room: rename or delete the room instead.',
      )
    if (!orchestrator || !row.recipe_ref || !row.recipe_kind || row.state === 'closed') return
    try {
      if (row.recipe_kind === 'workflow') await orchestrator.wfStop(row.recipe_ref)
      else await orchestrator.stop(row.recipe_ref)
    } catch (error) {
      // A run that already ended (or is gone) has nothing left to stop; the job still closes.
      if (!(error instanceof HttpError) || ![404, 409].includes(error.status)) throw error
    }
  }

  /**
   * Starts the oldest waiting call of each room that no longer has a job running, then its lead's turn. One room's
   * failure doesn't stop the others; its call stays first and is tried again at the next job end or call (review).
   */
  async function startNext(roomIds: Iterable<string>) {
    let started = false
    for (const roomId of new Set(roomIds)) {
      try {
        if (!db.read((sqlite) => hasQueued(sqlite, roomId))) continue
        await ingest.submit({
          source: 'triggers',
          identity: randomUUID(),
          apply: ({ sqlite, now }) => {
            const next = startQueued(sqlite, roomId, now)
            started ||= next.started
            return next.drafts
          },
        })
      } catch (error) {
        app.log.error({ err: error, roomId }, 'Starting the next queued trigger call failed')
      }
    }
    if (started) await dispatch()
  }

  // At start: a job that ended while Score was down left its room's queue waiting (review).
  app.addHook('onReady', async () => {
    const rooms = db.read(
      (sqlite) =>
        sqlite.prepare('SELECT DISTINCT room_id FROM room_queue').all() as { room_id: string }[],
    )
    if (rooms.length > 0) void startNext(rooms.map((row) => row.room_id))
  })

  // A job that ends by any path (Stop job, Close, Delete, its run ending, Done) frees its chat for the next call.
  const stopListening = ingest.onCommitted((events) => {
    const freed: string[] = []
    for (const event of events) {
      if (event.type === 'job.deleted') freed.push(event.data.roomId)
      else if (event.type === 'job.upserted' && ['closed', 'done'].includes(event.data.state))
        freed.push(event.data.roomId)
    }
    if (freed.length > 0) void startNext(freed)
  })
  app.addHook('onClose', async () => stopListening())

  app.post('/api/jobs/:jobId/end', mutation, async (request) => {
    const { jobId } = JobParams.parse(request.params)
    await stopRecipe(jobId)
    let running: { agentId: string; runId: string }[] = []
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        const ended = endJob(sqlite, jobId, now)
        running = ended.running
        return ended.drafts
      },
    })
    // A run that won't stop is reported by its own completion; the job is already closed.
    await Promise.allSettled(running.map((run) => port.stopRun(run)))
    await dispatch()
    return JobSchema.parse(
      db.read((sqlite) => {
        const row = jobRow(sqlite, jobId)
        if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that job.')
        return jobFromRow(sqlite, row)
      }),
    )
  })

  app.get('/api/rooms/:roomId/queue', async (request) => {
    const { roomId } = RoomParams.parse(request.params)
    const result = snapshot(db, (sqlite) => {
      roomRow(sqlite, roomId)
      return listQueue(sqlite, roomId)
    })
    return RoomQueueResponseSchema.parse({ asOfSeq: result.asOfSeq, items: result.data })
  })

  app.delete('/api/rooms/:roomId/queue/:itemId', mutation, async (request, reply) => {
    const { roomId, itemId } = QueueParams.parse(request.params)
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => skipQueued(sqlite, roomId, itemId, now),
    })
    return reply.code(204).send()
  })
}
