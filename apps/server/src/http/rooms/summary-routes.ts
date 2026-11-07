import { randomUUID } from 'node:crypto'
import { SummaryEditBodySchema, type MessagePartSchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../../auth/human.ts'
import { defaultJobId } from '../../domain/job-sessions.ts'
import { assertRoomFree } from '../../domain/orchestration/ownership.ts'
import { deleteMessage, roomRow } from '../../domain/rooms.ts'
import { requestSummary, sanitizeSummaryText } from '../../domain/room-summaries.ts'
import { visibleSummaries } from '../../domain/summary-stale.ts'
import { HttpError } from '../../errors.ts'
import type { RoomRouteDeps } from './context.ts'
import { ParamsSchema } from './route-schemas.ts'

export function registerSummaryRoutes(app: FastifyInstance, deps: RoomRouteDeps): void {
  const { db, ingest, mutation, routing, assertNotRewinding } = deps

  // Room summary (PLAN 7.4a). POST (re)generates it through the room's lead agent as a normal run; PATCH replaces
  // its text with the person's own; DELETE removes it (the plain recent window is used again).
  app.post('/api/rooms/:roomId/summary', mutation, async (request, reply) => {
    const { roomId } = ParamsSchema.parse(request.params)
    db.read((sqlite) => assertRoomFree(sqlite, roomId, 'summary.create'))
    // PLAN 11.2: one job's summary (a one-to-one, a team-room job); the room's default job when omitted.
    const { jobId } = z
      .object({ jobId: z.string().min(1).max(64).optional() })
      .strict()
      .parse(request.body ?? {})
    assertNotRewinding(roomId)
    let messageId = ''
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        if (
          jobId &&
          !sqlite.prepare('SELECT 1 FROM jobs WHERE id = ? AND room_id = ?').get(jobId, roomId)
        )
          throw new HttpError(404, 'not_found', 'Couldn’t find that job in this room.')
        messageId = requestSummary(sqlite, roomId, now, jobId)
        return []
      },
    })
    await routing.dispatch()
    return reply.code(202).send({ messageId })
  })

  app.patch('/api/rooms/:roomId/summary', mutation, async (request) => {
    const { roomId } = ParamsSchema.parse(request.params)
    db.read((sqlite) => assertRoomFree(sqlite, roomId, 'summary.edit'))
    const body = SummaryEditBodySchema.parse(request.body)
    assertNotRewinding(roomId)
    let parts: z.infer<typeof MessagePartSchema>[] = []
    let messageId = ''
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        roomRow(sqlite, roomId)
        const current = visibleSummaries(
          sqlite,
          roomId,
          summaryJob(request.query) ?? defaultJobId(sqlite, roomId) ?? '',
        )[0]
        if (!current) throw new HttpError(404, 'not_found', 'This room has no summary.')
        const text = sanitizeSummaryText(body.text)
        if (!text) throw new HttpError(400, 'bad_request', 'The summary can’t be empty.')
        // The person has read it and vouches for it: it is no longer stale.
        parts = [{ kind: 'summary', coversUntil: current.part.coversUntil, text, edited: true }]
        messageId = current.id
        sqlite
          .prepare(
            'UPDATE messages SET parts = ?, updated_at = ?, version = version + 1 WHERE id = ?',
          )
          .run(JSON.stringify(parts), now, current.id)
        return [{ type: 'message.updated', data: { roomId, messageId, parts } }]
      },
    })
    return { messageId, parts }
  })

  app.delete(
    '/api/rooms/:roomId/summary',
    { preHandler: [humanGuard(app.pairing)] },
    async (request, reply) => {
      const { roomId } = ParamsSchema.parse(request.params)
      db.read((sqlite) => assertRoomFree(sqlite, roomId, 'summary.delete'))
      await ingest.submit({
        source: 'rooms',
        identity: randomUUID(),
        apply: ({ sqlite, now }) => {
          roomRow(sqlite, roomId)
          const current = visibleSummaries(
            sqlite,
            roomId,
            summaryJob(request.query) ?? defaultJobId(sqlite, roomId) ?? '',
          )[0]
          if (!current) throw new HttpError(404, 'not_found', 'This room has no summary.')
          return deleteMessage(sqlite, roomId, current.id, now)
        },
      })
      return reply.code(204).send()
    },
  )
}

/** `?jobId=` on the summary routes (PLAN 11.2): which job's summary; the room's default job when absent. */
function summaryJob(query: unknown): string | undefined {
  return z
    .object({ jobId: z.string().min(1).max(64).optional() })
    .loose()
    .parse(query ?? {}).jobId
}
