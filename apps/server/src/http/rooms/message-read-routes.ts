import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../../auth/human.ts'
import { assertRoomFree } from '../../domain/orchestration/ownership.ts'
import {
  clearDirectThread,
  decodeMessageCursor,
  deleteMessage,
  jobsUnreadBefore,
  markRoomRead,
  messagePage,
} from '../../domain/rooms.ts'
import { snapshot } from '../../hub/snapshot.ts'
import type { RoomRouteDeps } from './context.ts'
import { ParamsSchema, QuerySchema } from './route-schemas.ts'

export function registerMessageReadRoutes(app: FastifyInstance, deps: RoomRouteDeps): void {
  const { db, ingest } = deps

  app.get('/api/rooms/:roomId/messages', async (request) => {
    const { roomId } = ParamsSchema.parse(request.params)
    const query = QuerySchema.parse(request.query)
    const before =
      query.before === undefined ? undefined : decodeMessageCursor(query.before, roomId)
    const all = query.all === '1'
    const page = snapshot(db, (sqlite) =>
      messagePage(sqlite, roomId, query.limit, before, query.jobId, all),
    )
    // Acknowledge only what this snapshot returned; later arrivals must remain unread. An empty streaming
    // placeholder has no content yet, so read state stops before the oldest one (its answer is still unseen).
    const items = page.data.items
    const readTarget = (list: typeof items) => {
      const oldestEmpty = list.findLastIndex((item) => item.streaming && item.parts.length === 0)
      return list[oldestEmpty + 1]
    }
    // An all-jobs read acknowledges each job up to its newest settled message in the page (reading a chat reads its topics).
    const newest = readTarget(items)
    // A job whose older unread messages fell outside this page stays unread: the page didn't show them.
    const oldest = items.at(-1)
    const unreadOutside =
      all && page.data.nextCursor && oldest
        ? db.read((sqlite) => jobsUnreadBefore(sqlite, roomId, oldest))
        : new Set<string>()
    const newestPerJob = all
      ? [...Map.groupBy(items, (item) => item.jobId ?? '').values()].flatMap((list) => {
          const target = readTarget(list)
          return target && !unreadOutside.has(target.jobId ?? '') ? [target] : []
        })
      : []
    if (!before)
      await ingest.submit({
        source: 'rooms',
        identity: randomUUID(),
        apply({ sqlite, now }) {
          return all
            ? newestPerJob.flatMap((item) => markRoomRead(sqlite, roomId, now, item))
            : markRoomRead(sqlite, roomId, now, newest)
        },
      })
    return { asOfSeq: page.asOfSeq, ...page.data }
  })

  // Naturally idempotent, and a 204 has no JSON body for a receipt, so no Idempotency-Key handling here.
  app.delete(
    '/api/rooms/:roomId/messages/:messageId',
    { preHandler: [humanGuard(app.pairing)] },
    async (request, reply) => {
      const { roomId, messageId } = z
        .object({ roomId: ParamsSchema.shape.roomId, messageId: z.string().min(1).max(200) })
        .parse(request.params)
      db.read((sqlite) => assertRoomFree(sqlite, roomId, 'message.delete'))
      await ingest.submit({
        source: 'rooms',
        identity: randomUUID(),
        apply: ({ sqlite, now }) => deleteMessage(sqlite, roomId, messageId, now),
      })
      return reply.code(204).send()
    },
  )

  // Clear a one-to-one's main chat (2.0.11): its messages deleted as one by one would, in one transaction.
  app.post(
    '/api/rooms/:roomId/clear',
    { preHandler: [humanGuard(app.pairing)] },
    async (request) => {
      const { roomId } = ParamsSchema.pick({ roomId: true }).parse(request.params)
      db.read((sqlite) => assertRoomFree(sqlite, roomId, 'message.delete'))
      let cleared = 0
      await ingest.submit({
        source: 'rooms',
        identity: randomUUID(),
        apply: ({ sqlite, now }) => {
          const result = clearDirectThread(sqlite, roomId, now)
          cleared = result.cleared
          return result.events
        },
      })
      return { cleared }
    },
  )
}
