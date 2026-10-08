import {
  TaskDetailSchema,
  TaskSummarySchema,
  type TaskDetail,
  type TaskSummary,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { ApprovalRowSchema, approvalView } from './approval-store.ts'
import type { DeriveEvents, DomainEventDraft } from '../hub/ingest.ts'

const RowSchema = z.object({
  detail: z.string(),
  revision: z.int(),
  incarnation: z.string().nullable(),
})

export function projectTask(
  sqlite: DatabaseSync,
  input: TaskDetail,
  revision = 0,
  incarnation: string | null = null,
): boolean {
  if (!sqlite.isTransaction) throw new Error('Task projections require a transaction')
  const task = TaskDetailSchema.parse(input)
  const value = sqlite
    .prepare('SELECT detail, revision, incarnation FROM task_projections WHERE id = ?')
    .get(task.id)
  if (value) {
    const row = RowSchema.parse(value)
    if (row.incarnation === incarnation && row.revision > revision) return false
  }
  sqlite
    .prepare(
      `INSERT INTO task_projections (id, detail, revision, incarnation) VALUES (?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET detail = excluded.detail, revision = excluded.revision, incarnation = excluded.incarnation`,
    )
    .run(task.id, JSON.stringify(task), revision, incarnation)
  return true
}

export function summaryDetail(summary: TaskSummary): TaskDetail {
  return {
    ...summary,
    body: '',
    createdBy: 'lead',
    steps: [],
    activity: [],
    pendingApproval: null,
    dependsOn: [],
    blocks: [],
    runIds: [],
  }
}

export function readProjectedTask(sqlite: DatabaseSync, id: string): TaskDetail | undefined {
  const row = sqlite
    .prepare('SELECT detail, revision, incarnation FROM task_projections WHERE id = ?')
    .get(id)
  return row ? TaskDetailSchema.parse(JSON.parse(RowSchema.parse(row).detail)) : undefined
}

export function taskWithApproval(
  sqlite: DatabaseSync,
  task: TaskDetail,
  now = Date.now(),
): TaskDetail {
  const rows = sqlite
    .prepare(
      `SELECT * FROM approvals WHERE visible = 1 AND phase = 'human_pending' AND status = 'pending'
    AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, id`,
    )
    .all(new Date(now).toISOString())
  const approval =
    rows
      .map((row) => approvalView(sqlite, ApprovalRowSchema.parse(row), { now }))
      .find((approval) =>
        approval.refs.some((ref) => ref.kind === 'task' && ref.taskId === task.id),
      ) ?? null
  return approval
    ? { ...task, column: 'needs_you', progress: null, pendingApproval: approval }
    : { ...task, pendingApproval: null }
}

export function projectedTasks(sqlite: DatabaseSync, now = Date.now()): TaskDetail[] {
  return sqlite
    .prepare('SELECT detail, revision, incarnation FROM task_projections ORDER BY id')
    .all()
    .map((row) =>
      taskWithApproval(
        sqlite,
        TaskDetailSchema.parse(JSON.parse(RowSchema.parse(row).detail)),
        now,
      ),
    )
}

export function taskSummary(task: TaskDetail): TaskSummary {
  return TaskSummarySchema.parse(task)
}

export function approvalTaskUpdates(
  sqlite: DatabaseSync,
  drafts: DomainEventDraft[],
  now: number,
): DomainEventDraft[] {
  const ids = new Set(
    drafts.flatMap((draft) =>
      draft.type === 'approval.requested' || draft.type === 'approval.updated'
        ? draft.data.refs.flatMap((ref) => (ref.kind === 'task' ? [ref.taskId] : []))
        : [],
    ),
  )
  return [...ids].flatMap((id) => {
    const task = readProjectedTask(sqlite, id)
    return task
      ? [{ type: 'task.upserted' as const, data: taskSummary(taskWithApproval(sqlite, task, now)) }]
      : []
  })
}

// Ingest hook (createIngest deriveEvents): live approval changes refresh their task cards atomically; the fake
// script schedules its own task cards.
export const deriveTaskEvents: DeriveEvents = (sqlite, drafts, { source, now }) =>
  source === 'fake' ? [] : approvalTaskUpdates(sqlite, drafts, Date.parse(now))
