import { BridgeIdentifierSchema } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { redactBounded } from '../redact.ts'
import { insertApproval } from './approvals.ts'
import { approvalDraft, patchApproval } from './approval-store.ts'

export const KanbanDenialSchema = z.object({
  patternKey: z.string().min(1).max(256),
  commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
  taskId: BridgeIdentifierSchema,
  runId: z.int().nonnegative().nullable(),
})
export function recordKanbanDenial(
  sqlite: DatabaseSync,
  denial: z.infer<typeof KanbanDenialSchema>,
  producer: { profile: string; id: string; incarnation: string },
  command: string,
  at: string,
  id?: string,
): DomainEventDraft[] {
  if (
    sqlite
      .prepare(
        `SELECT id FROM approvals WHERE origin = 'kanban' AND kanban_task_id = ? AND kanban_run_id IS ? AND command_digest = ?`,
      )
      .get(denial.taskId, denial.runId, denial.commandDigest)
  )
    return []
  const approvalId = insertApproval(sqlite, {
    ...(id ? { id } : {}),
    origin: 'kanban',
    stage: 'human',
    target_kind: 'none',
    visible: 1,
    profile: producer.profile,
    session_key: denial.taskId,
    producer_id: producer.id,
    producer_incarnation: producer.incarnation,
    kanban_task_id: denial.taskId,
    kanban_run_id: denial.runId,
    command,
    command_digest: denial.commandDigest,
    pattern_keys: [redactBounded(denial.patternKey, 256)],
    choices: [],
    surface: 'kanban',
    description:
      'Blocked in unattended mode: Hermes asks nobody for dangerous commands in Kanban workers.',
    blocking: `Task ${denial.taskId} is blocked`,
    expires_at: null,
    created_at: at,
  })
  return approvalDraft(sqlite, approvalId, {}, true)
}
export interface KanbanTaskState {
  id: string
  status: string
  current_run_id: number | null
}
// A denial card is obsolete when its task ended, went to triage, or a newer attempt started. A task that isn't
// "blocked" yet is not evidence: the worker reports the denial before Hermes marks the task blocked.
export function obsolete(runId: number | null, task: KanbanTaskState): boolean {
  if (['done', 'archived', 'triage'].includes(task.status)) return true
  return runId !== null && task.current_run_id !== null && task.current_run_id > runId
}
export function closeKanbanDenials(
  sqlite: DatabaseSync,
  tasks: KanbanTaskState[] | string[],
  at: string,
): DomainEventDraft[] {
  const drafts: DomainEventDraft[] = []
  for (const task of tasks) {
    // A bare id means Score itself unblocked the task: its cards are answered.
    const taskId = typeof task === 'string' ? task : task.id
    const rows = z
      .array(z.object({ id: z.string(), kanban_run_id: z.int().nullable() }))
      .parse(
        sqlite
          .prepare(
            `SELECT id, kanban_run_id FROM approvals WHERE origin = 'kanban' AND kanban_task_id = ? AND closed_reason IS NULL`,
          )
          .all(taskId),
      )
    for (const row of rows) {
      if (typeof task !== 'string' && !obsolete(row.kanban_run_id, task)) continue
      patchApproval(sqlite, row.id, { closed_reason: 'task_moved', closed_at: at }, at)
      drafts.push(...approvalDraft(sqlite, row.id))
    }
  }
  return drafts
}

export function openKanbanDenialIds(sqlite: DatabaseSync, taskId: string): string[] {
  return z
    .array(z.object({ id: z.string() }))
    .parse(
      sqlite
        .prepare(
          "SELECT id FROM approvals WHERE origin = 'kanban' AND kanban_task_id = ? AND closed_reason IS NULL",
        )
        .all(taskId),
    )
    .map(({ id }) => id)
}
export function closeKanbanDenialIds(
  sqlite: DatabaseSync,
  ids: readonly string[],
  at: string,
): DomainEventDraft[] {
  return ids.flatMap((id) => {
    if (
      !sqlite
        .prepare(
          "SELECT id FROM approvals WHERE id = ? AND origin = 'kanban' AND closed_reason IS NULL",
        )
        .get(id)
    )
      return []
    patchApproval(sqlite, id, { closed_reason: 'task_moved', closed_at: at }, at)
    return approvalDraft(sqlite, id)
  })
}
