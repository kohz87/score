import { randomUUID } from 'node:crypto'
import { closeKanbanDenialIds, openKanbanDenialIds } from '../domain/kanban-denials.ts'
import type { Ingest } from '../hub/ingest.ts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { TaskColumnSchema, type TaskColumn, type TaskSummary } from '@score/contract'
import {
  projectedTasks,
  readProjectedTask,
  taskWithApproval,
  taskSummary,
} from '../domain/tasks.ts'
import { snapshot } from '../hub/snapshot.ts'
import type { ScoreDb } from '../db/index.ts'
import { requestIdempotency } from './idempotency.ts'
import { humanGuard } from '../auth/human.ts'
import { HttpError } from '../errors.ts'
import { assertAgentAdmits } from '../domain/agent-lifecycle.ts'
import {
  CreateTaskSchema,
  PatchTaskSchema,
  TaskActionRequestSchema,
  matchesTask,
  type HermesPort,
} from '../hermes/index.ts'

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
  // Details repeat checklist text and include activity, so their receipts need more room than actions.
  const receipts = requestIdempotency(db, clock, 512 * 1024)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }
  const ParamsSchema = z.object({ taskId: z.string().min(1).max(256) })
  app.get('/api/tasks', async (request) => {
    const query = z
      .object({
        room: z.string().optional(),
        agent: z.string().optional(),
        needsYou: z.enum(['true', 'false']).optional(),
        column: TaskColumnSchema.optional(),
      })
      .strict()
      .parse(request.query)
    const filter = {
      ...(query.room ? { room: query.room } : {}),
      ...(query.agent ? { agent: query.agent } : {}),
      ...(query.needsYou ? { needsYou: query.needsYou === 'true' } : {}),
      ...(query.column ? { column: query.column } : {}),
    }
    const tasks = await port.listTasks(filter)
    const read = db
      ? snapshot(db, (sqlite) =>
          projectedTasks(sqlite, clock())
            .filter((task) => matchesTask(task, filter))
            .map(taskSummary),
        )
      : { asOfSeq: 0, data: tasks }
    const columns: Record<TaskColumn, TaskSummary[]> = {
      planned: [],
      working: [],
      in_review: [],
      needs_you: [],
      done: [],
    }
    for (const task of read.data) columns[task.column].push(task)
    return { asOfSeq: read.asOfSeq, columns }
  })
  app.get('/api/tasks/:taskId', async (request) => {
    const { taskId } = ParamsSchema.parse(request.params)
    const task = await port.getTask(taskId)
    return db
      ? db.read((sqlite) =>
          taskWithApproval(sqlite, readProjectedTask(sqlite, taskId) ?? task, clock()),
        )
      : task
  })
  app.post('/api/tasks', mutation, async (request) => {
    const req = CreateTaskSchema.parse(request.body)
    if (db) for (const id of [req.assignee, req.reviewer]) if (id) assertAgentAdmits(db.sqlite, id)
    const key = z
      .string()
      .regex(/^[\x21-\x7e]{1,256}$/)
      .parse(request.headers['idempotency-key'] ?? randomUUID())
    return port.createTask(req, key)
  })
  app.patch('/api/tasks/:taskId', mutation, async (request) => {
    const { taskId } = ParamsSchema.parse(request.params)
    const req = PatchTaskSchema.parse(request.body)
    if (db) for (const id of [req.assignee, req.reviewer]) if (id) assertAgentAdmits(db.sqlite, id)
    return port.patchTask(taskId, req)
  })
  app.post('/api/tasks/:taskId/actions', mutation, async (request) => {
    const { taskId } = ParamsSchema.parse(request.params)
    const body = BodySchema.parse(request.body)
    if (
      !TaskActionRequestSchema.safeParse({ ...body, taskId }).success &&
      body.action !== 'comment'
    )
      throw new HttpError(501, 'not_implemented', 'Task action is not implemented')
    if (body.action === 'comment' && !body.text?.trim())
      throw new HttpError(400, 'bad_request', 'A comment requires text')
    const oldIds = body.action === 'unblock' && db ? openKanbanDenialIds(db.sqlite, taskId) : []
    const result = await port.taskAction(
      TaskActionRequestSchema.parse({
        taskId,
        action: body.action,
        ...(body.text !== undefined ? { text: body.text } : {}),
      }),
    )
    if (body.action === 'unblock' && ingest && oldIds.length)
      await ingest.submit({
        source: 'task-actions',
        identity: randomUUID(),
        apply: ({ sqlite, now }) => closeKanbanDenialIds(sqlite, oldIds, now),
      })
    return { taskId, action: body.action, ...result }
  })
}
