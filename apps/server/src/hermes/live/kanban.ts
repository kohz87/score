import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  parseJson,
  readBatch,
  readByIds,
  TailInputSchema,
  TaskIdsSchema,
  type JsonValue,
} from './sqlite.ts'

const TextSchema = z.string().nullable()
const IntegerSchema = z.int().nullable()
const TaskEventRowSchema = z.object({
  id: z.int().positive(),
  task_id: z.string(),
  run_id: IntegerSchema,
  kind: z.string(),
  payload: TextSchema,
  created_at: z.int(),
})
export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: TextSchema,
  assignee: TextSchema,
  status: z.string(),
  priority: IntegerSchema,
  created_by: TextSchema,
  created_at: z.int(),
  started_at: IntegerSchema,
  completed_at: IntegerSchema,
  current_run_id: IntegerSchema,
  block_kind: TextSchema,
  session_id: TextSchema,
  result: TextSchema,
  workflow_template_id: TextSchema,
  current_step_key: TextSchema,
})
export const TaskRunSchema = z.object({
  id: z.int().positive(),
  task_id: z.string(),
  profile: TextSchema,
  step_key: TextSchema,
  status: z.string(),
  claim_lock: TextSchema,
  claim_expires: IntegerSchema,
  worker_pid: IntegerSchema,
  // INTEGER affinity also holds restart-stable text fingerprints in current Hermes.
  worker_started_at: z.union([z.int(), z.string()]).nullable(),
  max_runtime_seconds: IntegerSchema,
  last_heartbeat_at: IntegerSchema,
  started_at: z.int(),
  ended_at: IntegerSchema,
  outcome: TextSchema,
  summary: TextSchema,
  metadata: TextSchema,
  error: TextSchema,
})
export const TaskLinkSchema = z.object({ parent_id: z.string(), child_id: z.string() })
export const TaskCommentSchema = z.object({
  id: z.int().positive(),
  task_id: z.string(),
  author: z.string(),
  body: z.string(),
  created_at: z.int(),
})

export type TaskEvent = Omit<z.infer<typeof TaskEventRowSchema>, 'payload'> & {
  payload: JsonValue
}
export type Task = z.infer<typeof TaskSchema>
export type TaskRun = z.infer<typeof TaskRunSchema>
export type TaskLink = z.infer<typeof TaskLinkSchema>
export type TaskComment = z.infer<typeof TaskCommentSchema>

export function tailTaskEvents(db: DatabaseSync, input: z.input<typeof TailInputSchema>) {
  const { afterId, limit } = TailInputSchema.parse(input)
  const batch = readBatch(
    db,
    'task_events',
    TaskEventRowSchema,
    'WHERE id > ? ORDER BY id LIMIT ?',
    [afterId, limit],
    true,
  )
  let malformed = batch.malformed
  const rows: TaskEvent[] = batch.rows.map((row) => {
    const payload = parseJson(row.payload)
    malformed += payload.malformed
    return { ...row, payload: payload.value }
  })
  return { ...batch, rows, malformed }
}

export function readTasks(db: DatabaseSync, ids: string[]) {
  return readByIds(db, 'tasks', TaskSchema, ids, ['id'], 'id')
}

export const TaskBoardRowSchema = TaskSchema.extend({ task_rowid: z.int().positive() })
export function readTaskBoard(db: DatabaseSync) {
  const batch = readBatch(db, 'tasks', TaskSchema, 'ORDER BY rowid', [])
  const ids = new Map(
    z
      .array(z.object({ id: z.string(), task_rowid: z.int().positive() }))
      .parse(db.prepare('SELECT id, rowid AS task_rowid FROM tasks').all())
      .map((row) => [row.id, row.task_rowid]),
  )
  return {
    ...batch,
    rows: batch.rows.map((row) =>
      TaskBoardRowSchema.parse({ ...row, task_rowid: ids.get(row.id) }),
    ),
  }
}

export function readTaskEvents(db: DatabaseSync, taskId: string) {
  z.string().min(1).parse(taskId)
  const batch = readBatch(
    db,
    'task_events',
    TaskEventRowSchema,
    'WHERE task_id = ? ORDER BY id DESC LIMIT 50',
    [taskId],
  )
  return {
    ...batch,
    rows: batch.rows.map((row) => ({ ...row, payload: parseJson(row.payload).value })),
  }
}

/** Every review event of a task, oldest first, independent of the 50-event activity window (Flow backfill). */
export function readReviewEvents(db: DatabaseSync, taskId: string) {
  z.string().min(1).parse(taskId)
  const batch = readBatch(
    db,
    'task_events',
    TaskEventRowSchema,
    "WHERE task_id = ? AND kind IN ('review_requested', 'changes_requested') ORDER BY id",
    [taskId],
  )
  return {
    ...batch,
    rows: batch.rows.map((row) => ({ ...row, payload: parseJson(row.payload).value })),
  }
}

/** The newest review event of a task, whatever the 50-event activity window holds. */
export function readLatestReviewEvent(db: DatabaseSync, taskId: string) {
  z.string().min(1).parse(taskId)
  const batch = readBatch(
    db,
    'task_events',
    TaskEventRowSchema,
    "WHERE task_id = ? AND kind IN ('review_requested', 'changes_requested') ORDER BY id DESC LIMIT 1",
    [taskId],
  )
  return {
    ...batch,
    rows: batch.rows.map((row) => ({ ...row, payload: parseJson(row.payload).value })),
  }
}

export function readTaskRuns(db: DatabaseSync, input: z.input<typeof TaskIdsSchema>) {
  const { taskIds } = TaskIdsSchema.parse(input)
  return readByIds(db, 'task_runs', TaskRunSchema, taskIds, ['task_id'], 'id')
}

export function readTaskLinks(db: DatabaseSync, input: z.input<typeof TaskIdsSchema>) {
  const { taskIds } = TaskIdsSchema.parse(input)
  return readByIds(
    db,
    'task_links',
    TaskLinkSchema,
    taskIds,
    ['parent_id', 'child_id'],
    'parent_id, child_id',
  )
}

export function readTaskComments(db: DatabaseSync, input: z.input<typeof TaskIdsSchema>) {
  const { taskIds } = TaskIdsSchema.parse(input)
  return readByIds(db, 'task_comments', TaskCommentSchema, taskIds, ['task_id'], 'id')
}
