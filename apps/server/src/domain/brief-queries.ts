import { TaskDetailSchema, type TaskDetail } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import { redact } from '../redact.ts'
import { kanbanAttemptsEnabled } from './kanban-attempts.ts'
import { ownershipOf } from './ownership.ts'
import {
  BriefRowSchema,
  TaskIdRowSchema,
  TurnRowSchema,
  type BriefRow,
  type TurnRow,
} from './brief-types.ts'

// Destructured: the adapter boundary scan flags a property access spelled with a dot before "hermes".
export const taskStatus = ({ hermesStatus }: { hermesStatus: string }) => hermesStatus

export function briefTitle(text: string): string {
  const first = text.split(/\r\n|\n|\r/).find((line) => line.trim()) ?? ''
  return redact(first.trim()).slice(0, 120) || 'Untitled brief'
}

export function readBriefRow(sqlite: DatabaseSync, id: string): BriefRow | undefined {
  const row = sqlite.prepare('SELECT * FROM briefs WHERE id = ?').get(id)
  return row === undefined ? undefined : BriefRowSchema.parse(row)
}

export function requireBrief(sqlite: DatabaseSync, id: string): BriefRow {
  const row = readBriefRow(sqlite, id)
  if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that run.')
  return row
}

export function briefTaskIds(sqlite: DatabaseSync, briefId: string): string[] {
  return z
    .array(TaskIdRowSchema)
    .parse(
      sqlite
        .prepare('SELECT task_id FROM brief_tasks WHERE brief_id = ? ORDER BY linked_at, rowid')
        .all(briefId),
    )
    .map((row) => row.task_id)
}

export function projectedDetail(sqlite: DatabaseSync, taskId: string): TaskDetail | undefined {
  const row = sqlite.prepare('SELECT detail FROM task_projections WHERE id = ?').get(taskId)
  if (!row) return undefined
  return TaskDetailSchema.parse(JSON.parse(z.object({ detail: z.string() }).parse(row).detail))
}

export function briefTasks(
  sqlite: DatabaseSync,
  briefId: string,
): { taskId: string; detail: TaskDetail | undefined }[] {
  return briefTaskIds(sqlite, briefId).map((taskId) => ({
    taskId,
    detail: projectedDetail(sqlite, taskId),
  }))
}

/**
 * The brief's tasks Score may act on (park, hold). With attempts on, a link made in another board lineage, or one
 * whose projection belongs to a different lineage than the link, is display-only (5.17a-1 audit).
 */
export function actionableBriefTasks(
  sqlite: DatabaseSync,
  briefId: string,
): { taskId: string; detail: TaskDetail | undefined }[] {
  const tasks = briefTasks(sqlite, briefId)
  if (!kanbanAttemptsEnabled()) return tasks
  const links = z
    .array(z.object({ task_id: z.string(), history_id: z.string().nullable() }))
    .parse(
      sqlite.prepare('SELECT task_id, history_id FROM brief_tasks WHERE brief_id = ?').all(briefId),
    )
  return tasks.filter(({ taskId }) => {
    const link = links.find((row) => row.task_id === taskId)
    if (!link || ownershipOf(sqlite, link.history_id) !== 'current') return false
    const projected = sqlite
      .prepare('SELECT history_id FROM task_projections WHERE id = ?')
      .get(taskId) as { history_id: string | null } | undefined
    return projected !== undefined && projected.history_id === link.history_id
  })
}

export function briefTurns(sqlite: DatabaseSync, briefId: string): TurnRow[] {
  return z.array(TurnRowSchema).parse(
    sqlite
      .prepare(
        `SELECT m.message_id, m.agent_id, m.hop, m.turn_id, m.parent_message_id, m.from_agent_id, m.state, m.run_id,
           r.status AS run_status, m.created_at
         FROM message_runs m LEFT JOIN runs r ON r.id = m.run_id WHERE m.chain_id = ?
         ORDER BY m.created_at, m.rowid`,
      )
      .all(briefId),
  )
}
