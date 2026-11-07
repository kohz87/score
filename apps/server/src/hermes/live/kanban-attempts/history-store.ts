import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { effectiveMark } from './history-policy.ts'
import type { Marks } from './types.ts'

const HistoryRowSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  opened_at: z.string(),
  closed_at: z.string().nullable(),
  state: z.enum(['active', 'paused', 'closed']),
  reason: z.string().nullable(),
  event_alloc_mark: z.int(),
  attempt_alloc_mark: z.int(),
  event_cursor: z.int(),
  baseline_cursor: z.int(),
  baseline_done: z.int(),
  fullpass_cursor: z.int(),
  file_identity: z.string().nullable(),
})
export type HistoryRow = z.infer<typeof HistoryRowSchema>

export function liveHistory(sqlite: DatabaseSync, sourceId: string): HistoryRow | undefined {
  const row = sqlite
    .prepare("SELECT * FROM kanban_histories WHERE source_id = ? AND state != 'closed'")
    .get(sourceId)
  return row === undefined ? undefined : HistoryRowSchema.parse(row)
}

export function readHistory(sqlite: DatabaseSync, id: string): HistoryRow | undefined {
  const row = sqlite.prepare('SELECT * FROM kanban_histories WHERE id = ?').get(id)
  return row === undefined ? undefined : HistoryRowSchema.parse(row)
}

export function ensureSource(
  sqlite: DatabaseSync,
  source: { id: string; path: string; board: string },
  now: string,
): void {
  sqlite
    .prepare(
      'INSERT INTO kanban_sources (id, path, board, first_seen) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
    )
    .run(source.id, source.path, source.board, now)
}

/** Marks to save when a history opens: the allocation marks and the end of the events already behind it. */
function openingMarks(
  marks: Marks,
): { event: number; attempt: number; cursor: number } | undefined {
  const events = effectiveMark('task_events', marks.eventSeq, marks.eventMin, marks.eventMax)
  const runs = effectiveMark('task_runs', marks.runSeq, marks.runMin, marks.runMax)
  if ('insufficient' in events || 'insufficient' in runs) return undefined
  // Events before the opening are covered by the baseline of attempts; the tail starts at the current end.
  return { event: events.mark, attempt: runs.mark, cursor: marks.eventMax ?? 0 }
}

export function openHistory(
  sqlite: DatabaseSync,
  input: { sourceId: string; marks: Marks; fileIdentity: string; now: string; newId?: string },
): string | undefined {
  const opening = openingMarks(input.marks)
  if (!opening) return undefined
  const id = input.newId ?? `kh_${randomUUID()}`
  sqlite
    .prepare(
      `INSERT INTO kanban_histories
         (id, source_id, opened_at, state, event_alloc_mark, attempt_alloc_mark, event_cursor, file_identity)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.sourceId,
      input.now,
      opening.event,
      opening.attempt,
      opening.cursor,
      input.fileIdentity,
    )
  return id
}

/** Observation stops for every open attempt that was under observation: a boundary, never an end time. */
function endObservation(sqlite: DatabaseSync, historyId: string, now: string): string[] {
  const ids = openObservedIds(sqlite, historyId)
  sqlite
    .prepare(
      `UPDATE kanban_attempts
          SET observing = 0, observation_ended_at = ?, observation_gaps = observation_gaps + 1
        WHERE history_id = ? AND ended_at IS NULL AND observing = 1`,
    )
    .run(now, historyId)
  return ids
}

function openObservedIds(sqlite: DatabaseSync, historyId: string): string[] {
  return z
    .array(z.object({ id: z.string() }))
    .parse(
      sqlite
        .prepare(
          'SELECT id FROM kanban_attempts WHERE history_id = ? AND ended_at IS NULL AND observing = 1',
        )
        .all(historyId),
    )
    .map((row) => row.id)
}

/** Pauses the live history; returns the attempts whose observation just ended (null = nothing to pause). */
export function pauseHistory(
  sqlite: DatabaseSync,
  historyId: string,
  reason: string,
  now: string,
): string[] | null {
  const history = readHistory(sqlite, historyId)
  if (!history || history.state === 'closed') return null
  const ended = endObservation(sqlite, historyId, now)
  sqlite
    .prepare("UPDATE kanban_histories SET state = 'paused', reason = ? WHERE id = ?")
    .run(reason.slice(0, 300), historyId)
  return ended
}

export function closeHistory(
  sqlite: DatabaseSync,
  historyId: string,
  reason: string,
  now: string,
): string[] {
  const ended = endObservation(sqlite, historyId, now)
  sqlite
    .prepare("UPDATE kanban_histories SET state = 'closed', closed_at = ?, reason = ? WHERE id = ?")
    .run(now, reason.slice(0, 300), historyId)
  return ended
}

export function resumeHistory(sqlite: DatabaseSync, historyId: string, now: string): string[] {
  const resumed = z
    .array(z.object({ id: z.string() }))
    .parse(
      sqlite
        .prepare(
          `SELECT id FROM kanban_attempts
            WHERE history_id = ? AND ended_at IS NULL AND observing = 0 AND deleted_upstream_at IS NULL`,
        )
        .all(historyId),
    )
    .map((row) => row.id)
  sqlite
    .prepare("UPDATE kanban_histories SET state = 'active', reason = NULL WHERE id = ?")
    .run(historyId)
  // The boundary stays as recorded history; observation continues from here with the gap retained.
  sqlite
    .prepare(
      `UPDATE kanban_attempts SET observing = 1, observation_resumed_at = ?
        WHERE history_id = ? AND ended_at IS NULL AND observing = 0 AND deleted_upstream_at IS NULL`,
    )
    .run(now, historyId)
  return resumed
}
