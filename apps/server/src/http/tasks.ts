// Hermes tasks after the board went (decision 121): the new shell reads them and acts on them. 3.27.0 (DECISIONS 162):
// the Tasks page creates and edits them again (POST, PATCH) and moves or archives them through the actions route.
import { randomUUID } from 'node:crypto'
import { closeKanbanDenialIds, openKanbanDenialIds } from '../domain/kanban-denials.ts'
import type { Ingest } from '../hub/ingest.ts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  TaskColumnSchema,
  TaskCreateRequestSchema,
  TaskPatchRequestSchema,
  type TaskColumn,
  type TaskSummary,
} from '@score/contract'
import {
  projectedTasks,
  readProjectedTask,
  taskWithApproval,
  taskSummary,
} from '../domain/tasks.ts'
import { withRunLinks } from '../domain/legacy-links.ts'
import { snapshot } from '../hub/snapshot.ts'
import type { ScoreDb } from '../db/index.ts'
import { requestIdempotency } from './idempotency.ts'
import { humanGuard } from '../auth/human.ts'
import { HttpError } from '../errors.ts'
import { assertAgentAdmits } from '../domain/agent-lifecycle.ts'
import { TaskActionRequestSchema, matchesTask, type HermesPort } from '../hermes/index.ts'

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
  // 3.27.0 review: a create reconciles with Hermes' own idempotency key (command intents), so a retry after a server
  // error or a crash may run again instead of replaying the failure for a day.
  const createReceipts = requestIdempotency(db, clock, 512 * 1024, { rerunUncertain: true })
  const creates = {
    preHandler: [humanGuard(app.pairing), createReceipts.preHandler],
    onSend: createReceipts.onSend,
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
      ? db.read((sqlite) => {
          const detail = taskWithApproval(
            sqlite,
            readProjectedTask(sqlite, taskId) ?? task,
            clock(),
          )
          const brief = sqlite
            .prepare(
              'SELECT brief_id FROM brief_tasks WHERE task_id = ? ORDER BY linked_at DESC, rowid DESC LIMIT 1',
            )
            .get(taskId) as { brief_id: string } | undefined
          const linked = withRunLinks(sqlite, detail)
          return brief ? { ...linked, briefId: brief.brief_id } : linked
        })
      : task
  })
  // Creating a task: the idempotency key is passed to Hermes too, so a retried create never makes a second task.
  app.post('/api/tasks', creates, async (request, reply) => {
    const req = TaskCreateRequestSchema.parse(request.body)
    if (db && req.assignee) assertAgentAdmits(db.sqlite, req.assignee)
    if (db && req.roomId) {
      const room = db.read((sqlite) =>
        sqlite.prepare('SELECT id FROM rooms WHERE id = ?').get(req.roomId!),
      )
      if (!room)
        throw new HttpError(400, 'bad_request', 'That chat doesn’t exist any more. Pick another.')
    }
    const key = z
      .string()
      .regex(/^[\x21-\x7e]{1,256}$/)
      .parse(request.headers['idempotency-key'] ?? randomUUID())
    const { start, ...fields } = req
    let created = await port.createTask(fields, key)
    // The task exists once Hermes made it: a failed start leaves it Planned (with its Start button) and the answer is
    // still 201, so a retry never makes a second task.
    let startFailed = false
    if (start === 'now') {
      try {
        await port.taskAction(
          TaskActionRequestSchema.parse({ taskId: created.id, action: 'start' }),
        )
        created = await port.getTask(created.id)
      } catch {
        startFailed = true
      }
    }
    const body = db ? db.read((sqlite) => withRunLinks(sqlite, created)) : created
    return reply.code(201).send(startFailed ? { ...body, startFailed: true } : body)
  })
  app.patch('/api/tasks/:taskId', mutation, async (request) => {
    const { taskId } = ParamsSchema.parse(request.params)
    const req = TaskPatchRequestSchema.parse(request.body)
    if (db && req.assignee) assertAgentAdmits(db.sqlite, req.assignee)
    const patched = await port.patchTask(taskId, req)
    return db ? db.read((sqlite) => withRunLinks(sqlite, patched)) : patched
  })
  app.post('/api/tasks/:taskId/actions', mutation, async (request) => {
    const { taskId } = ParamsSchema.parse(request.params)
    const body = BodySchema.parse(request.body)
    if (
      !TaskActionRequestSchema.safeParse({ ...body, taskId }).success &&
      body.action !== 'comment'
    )
      throw new HttpError(501, 'not_implemented', 'That task action isn’t available yet.')
    if (body.action === 'comment' && !body.text?.trim())
      throw new HttpError(400, 'bad_request', 'Write something to comment.')
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
