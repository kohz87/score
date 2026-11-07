import {
  BriefSummarySchema,
  type BriefStatus,
  type BriefSummary,
  type TaskDetail,
} from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { briefTasks, briefTurns, readBriefRow, taskStatus } from './brief-queries.ts'
import { BriefRowSchema, type BriefRow } from './brief-types.ts'

export const TERMINAL_TASK_STATUSES = ['done', 'archived']
export const ACTIVE_RUN_STATUSES = ['queued', 'running', 'waiting_for_approval']
const FAILED_RUN_STATUSES = ['failed', 'interrupted']
const PAGE = 500
const WEEK_MS = 7 * 24 * 3600 * 1000

const RunStatusRowSchema = z.object({
  status: z.string(),
  ended_at: z.string().nullable(),
  started_at: z.string(),
})
function runStatuses(sqlite: DatabaseSync, runIds: string[]) {
  return runIds.flatMap((id) => {
    const row = sqlite.prepare('SELECT status, ended_at, started_at FROM runs WHERE id = ?').get(id)
    return row === undefined ? [] : [{ id, ...RunStatusRowSchema.parse(row) }]
  })
}

// Statuses in which Hermes still intends to run or hand the task on (retry, input, review): a failed
// attempt is then one step of the task's story, not its outcome.
const OPEN_TASK_STATUSES = ['triage', 'todo', 'ready', 'running', 'scheduled', 'blocked', 'review']

/** Newest first; Hermes timestamps have second resolution, so the id breaks ties deterministically. */
export function newestFirst(
  left: { id: string; started_at: string },
  right: { id: string; started_at: string },
): number {
  return left.started_at < right.started_at
    ? 1
    : left.started_at > right.started_at
      ? -1
      : left.id < right.id
        ? 1
        : left.id > right.id
          ? -1
          : 0
}

/**
 * A task counts as failed when its most recent run failed, the task did not finish afterwards and Hermes
 * is not waiting on a retry, input or review (attempt failure is not task disposition).
 */
export function taskFailed(sqlite: DatabaseSync, detail: TaskDetail): boolean {
  if (detail.column === 'done') return false
  if (OPEN_TASK_STATUSES.includes(taskStatus(detail))) return false
  const last = runStatuses(sqlite, detail.runIds).sort(newestFirst)[0]
  return last !== undefined && FAILED_RUN_STATUSES.includes(last.status)
}

export function deriveBriefStatus(sqlite: DatabaseSync, row: BriefRow): BriefStatus {
  // An orchestration's brief takes its status from the run, never from the turns between lead attempts (PLAN 7.5).
  const run = sqlite.prepare('SELECT status FROM orchestrations WHERE brief_id = ?').get(row.id) as
    { status: string } | undefined
  if (run)
    return (
      (
        {
          running: 'running',
          stopping: 'running',
          finishing: 'running',
          paused: 'paused',
          succeeded: 'done',
          stopped: 'done',
        } as Record<string, BriefStatus>
      )[run.status] ?? 'failed'
    )
  if (row.paused_at !== null) return 'paused'
  const turns = briefTurns(sqlite, row.id)
  const tasks = briefTasks(sqlite, row.id)
  const running =
    turns.some(
      (turn) =>
        turn.state === 'pending' ||
        turn.state === 'active' ||
        (turn.run_status !== null && ACTIVE_RUN_STATUSES.includes(turn.run_status)),
    ) || tasks.some(({ detail }) => !detail || !TERMINAL_TASK_STATUSES.includes(taskStatus(detail)))
  if (running) return 'running'
  const last = turns.at(-1)
  const lastFailed =
    last !== undefined &&
    (last.state === 'failed' ||
      (last.run_status !== null && FAILED_RUN_STATUSES.includes(last.run_status)))
  if (lastFailed || tasks.some(({ detail }) => detail && taskFailed(sqlite, detail)))
    return 'failed'
  return 'done'
}

export function briefSummary(sqlite: DatabaseSync, row: BriefRow): BriefSummary {
  return BriefSummarySchema.parse({
    id: row.id,
    title: row.title,
    roomId: row.room_id,
    startedAt: row.started_at,
    startedBy: row.started_by,
    status: deriveBriefStatus(sqlite, row),
  })
}

/** Emits the brief when its status differs from the last one an event carried (or `force`). */
export function emitBrief(sqlite: DatabaseSync, id: string, force = false): DomainEventDraft[] {
  const row = readBriefRow(sqlite, id)
  if (!row) return []
  const summary = briefSummary(sqlite, row)
  if (!force && row.emitted_status === summary.status) return []
  sqlite.prepare('UPDATE briefs SET emitted_status = ? WHERE id = ?').run(summary.status, id)
  return [{ type: 'brief.upserted', data: summary }]
}
export const emitBriefChange = emitBrief

/** Last activity of a brief: its start, or the latest end of any of its turns' or tasks' runs. */
export function briefLastEnd(sqlite: DatabaseSync, row: BriefRow): string {
  const ends = [
    ...briefTurns(sqlite, row.id).flatMap((turn) => (turn.run_id ? [turn.run_id] : [])),
    ...briefTasks(sqlite, row.id).flatMap(({ detail }) => detail?.runIds ?? []),
  ]
  return runStatuses(sqlite, ends).reduce(
    (latest, run) => (run.ended_at && run.ended_at > latest ? run.ended_at : latest),
    row.started_at,
  )
}

export function listBriefs(
  sqlite: DatabaseSync,
  status: 'active' | 'recent',
  nowMs: number,
): BriefSummary[] {
  const cutoff = new Date(nowMs - WEEK_MS).toISOString()
  const result: BriefSummary[] = []
  // Page through the table: a limit applied before the status filter would hide older unfinished briefs.
  for (let offset = 0; ; offset += PAGE) {
    const rows = z
      .array(BriefRowSchema)
      .parse(
        sqlite
          .prepare('SELECT * FROM briefs ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?')
          .all(PAGE, offset),
      )
    for (const row of rows) {
      const summary = briefSummary(sqlite, row)
      const active = summary.status === 'running' || summary.status === 'paused'
      if (status === 'active' ? active : !active && briefLastEnd(sqlite, row) >= cutoff)
        result.push(summary)
      if (status === 'recent' && result.length >= 50) return result
    }
    if (rows.length < PAGE) return result
  }
}
