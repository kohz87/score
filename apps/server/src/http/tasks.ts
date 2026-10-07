import { randomUUID } from 'node:crypto'
import { closeKanbanDenials } from '../domain/kanban-denials.ts'
import type { Ingest } from '../hub/ingest.ts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
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
): void {
  app.post(
    '/api/tasks/:taskId/actions',
    { preHandler: humanGuard(app.pairing) },
    async (request) => {
      const { taskId } = z.object({ taskId: z.string().min(1).max(256) }).parse(request.params)
      const body = BodySchema.parse(request.body)
      if (body.action !== 'comment' && body.action !== 'unblock')
        throw new HttpError(501, 'not_implemented', 'Task action is not implemented')
      if (body.action === 'comment' && !body.text?.trim())
        throw new HttpError(400, 'bad_request', 'A comment requires text')
      const result = await port.taskAction({
        taskId,
        action: body.action,
        ...(body.text !== undefined ? { text: body.text } : {}),
      })
      if (body.action === 'unblock' && ingest)
        await ingest.submit({
          source: 'task-actions',
          identity: randomUUID(),
          apply: ({ sqlite, now }) => closeKanbanDenials(sqlite, [taskId], now),
        })
      return { taskId, action: body.action, ...result }
    },
  )
}
