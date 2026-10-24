import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { assertRoomFree } from '../domain/orchestration/ownership.ts'
import { requestIdempotency } from './idempotency.ts'
import type { PlanStarter } from './plan-start.ts'

const PlanParams = z.object({
  roomId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
})

export function registerBriefRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    plans: PlanStarter
    clock?: () => number
  },
): void {
  const { db, plans } = deps
  const clock = deps.clock ?? Date.now
  const receipts = requestIdempotency(db, clock)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }

  // Start plan (H): the only thing that turns a proposed plan into tasks. Durable and idempotent per step
  // (plan-start.ts): a repeated start, or a restart, resumes where the last one stopped.
  app.post('/api/rooms/:roomId/messages/:messageId/plan/start', mutation, (request) => {
    const { roomId, messageId } = PlanParams.parse(request.params)
    db.read((sqlite) => assertRoomFree(sqlite, roomId, 'plan.start'))
    return plans.start(roomId, messageId)
  })
}
