import { randomUUID } from 'node:crypto'
import { closeKanbanDenialIds, openKanbanDenialIds } from '../domain/kanban-denials.ts'
import type { Ingest } from '../hub/ingest.ts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { requestIdempotency } from './idempotency.ts'
import { humanGuard } from '../auth/human.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'

const BodySchema = z.object({
  action: z.string().min(1).max(64),
  text: z
    .string()
    .max(2000)
    .refine((value) => !value.includes('\0'))
    .optional(),
})
export function registerTaskRoutes(
  app: FastifyInstance,
  port: HermesPort,
  ingest?: Pick<Ingest, 'submit'>,
  db?: ScoreDb,
  clock = Date.now,
): void {
  const receipts = requestIdempotency(db, clock)
  app.post(
    '/api/tasks/:taskId/actions',
    { preHandler: [humanGuard(app.pairing), receipts.preHandler], onSend: receipts.onSend },
    async (request) => {
      const { taskId } = z.object({ taskId: z.string().min(1).max(256) }).parse(request.params)
      const body = BodySchema.parse(request.body)
      if (body.action !== 'comment' && body.action !== 'unblock')
        throw new HttpError(501, 'not_implemented', 'Task action is not implemented')
      if (body.action === 'comment' && !body.text?.trim())
        throw new HttpError(400, 'bad_request', 'A comment requires text')
      const oldIds = body.action === 'unblock' && db ? openKanbanDenialIds(db.sqlite, taskId) : []
      const result = await port.taskAction({
        taskId,
        action: body.action,
        ...(body.text !== undefined ? { text: body.text } : {}),
      })
      if (body.action === 'unblock' && ingest && oldIds.length)
        await ingest.submit({
          source: 'task-actions',
          identity: randomUUID(),
          apply: ({ sqlite, now }) => closeKanbanDenialIds(sqlite, oldIds, now),
        })
      return { taskId, action: body.action, ...result }
    },
  )
}
