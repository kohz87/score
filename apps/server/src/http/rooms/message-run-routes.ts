import { randomUUID } from 'node:crypto'
import { RetryReplyRequestSchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { assertRoomFree } from '../../domain/orchestration/ownership.ts'
import { retryReply } from '../../domain/message-runs.ts'
import { HttpError } from '../../errors.ts'
import type { RoomRouteDeps } from './context.ts'
import { ParamsSchema } from './route-schemas.ts'

export function registerMessageRunRoutes(app: FastifyInstance, deps: RoomRouteDeps): void {
  const { db, ingest, port, mutation, routing, assertNotRewinding } = deps

  app.post('/api/rooms/:roomId/messages/:messageId/retry', mutation, async (request, reply) => {
    assertNotRewinding(ParamsSchema.parse(request.params).roomId)
    const { roomId, messageId } = z
      .object({ roomId: ParamsSchema.shape.roomId, messageId: z.string().min(1).max(200) })
      .parse(request.params)
    db.read((sqlite) => assertRoomFree(sqlite, roomId, 'message.retry'))
    // An empty body is a plain Retry; `another` asks for a different answer (2.4.0).
    const parsed = RetryReplyRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw new HttpError(400, 'bad_request', 'That isn’t a valid retry.')
    const body = parsed.data
    const nonce = randomUUID()
    let replyId = ''
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        replyId = retryReply(sqlite, roomId, messageId, nonce, now, body)
        return []
      },
    })
    await routing.dispatch()
    return reply.code(202).send({ messageId: replyId })
  })

  // Stop (PLAN 5.25): ends the Score-started run that is writing a streaming reply. The run's cancelled status then
  // completes the reply with "This run was stopped." through the normal path.
  app.post('/api/rooms/:roomId/messages/:messageId/stop', mutation, async (request) => {
    const { roomId, messageId } = z
      .object({ roomId: ParamsSchema.shape.roomId, messageId: z.string().min(1).max(200) })
      .parse(request.params)
    db.read((sqlite) => assertRoomFree(sqlite, roomId, 'message.stop'))
    const row = z
      .object({
        run_id: z.string().nullable(),
        agent_id: z.string().min(1),
        state: z.enum(['pending', 'active', 'completed', 'failed']),
      })
      .nullish()
      .parse(
        db.sqlite
          .prepare(
            `SELECT mr.run_id, mr.agent_id, mr.state FROM message_runs mr JOIN messages m ON m.id = mr.message_id
             WHERE mr.message_id = ? AND mr.room_id = ? AND m.deleted_at IS NULL`,
          )
          .get(messageId, roomId),
      )
    if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that message.')
    if (row.state !== 'active' || !row.run_id)
      throw new HttpError(409, 'conflict', 'This reply isn’t being written right now.')
    await port.stopRun({ agentId: row.agent_id, runId: row.run_id })
    return { ok: true }
  })
}
