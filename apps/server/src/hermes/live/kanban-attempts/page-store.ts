import type { DatabaseSync } from 'node:sqlite'
import type { Capture } from './types.ts'

export type PageOutcome = 'applied' | 'stale' | 'paused' | 'contradiction'

export function recordPage(
  sqlite: DatabaseSync,
  capture: Capture,
  historyId: string,
  outcome: PageOutcome,
): void {
  const ids = capture.attempts.map((attempt) => attempt.id)
  const from = capture.range ? capture.range.from : ids.length ? Math.min(...ids) : null
  const to = capture.range ? capture.range.to : ids.length ? Math.max(...ids) : null
  sqlite
    .prepare(
      `INSERT INTO kanban_pages
         (capture_id, kind, history_id, event_from, event_to, attempt_from, attempt_to, captured_at, outcome, malformed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      capture.captureId,
      capture.kind,
      historyId,
      capture.eventFrom,
      capture.eventTo,
      from,
      to,
      capture.capturedAt,
      outcome,
      capture.malformed,
    )
}
