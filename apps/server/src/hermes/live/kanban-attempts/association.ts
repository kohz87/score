import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { emitBriefChange, recordEdge } from '../../../domain/briefs.ts'
import type { ScoreDb } from '../../../db/index.ts'
import type { ObservationSink } from '../../port.ts'
import { reviewTransitionsFrom } from '../flow-history.ts'
import { readReviewEvents } from '../kanban.ts'

// Late relationship backfill (design v5 §G). A brief linked to a task after the task's review events were consumed
// still needs its review edges. Progress is durable per (history, brief, event); every edge commits together with its
// progress row, so a crash mid-backfill resumes without duplicates. Task activity is never re-emitted.

const TASKS_PER_PASS = 20
const LinkSchema = z.object({ brief_id: z.string(), task_id: z.string() })

export async function associationPass(
  db: ScoreDb,
  sink: ObservationSink,
  hermes: DatabaseSync,
  history: { id: string; sourceId: string; fileIdentity: string },
  hooks: { afterEdge?: () => void } = {},
): Promise<number> {
  const pending = z.array(LinkSchema).parse(
    db.sqlite
      .prepare(
        `SELECT bt.brief_id, bt.task_id FROM brief_tasks bt
          WHERE bt.history_id = ?
            AND NOT EXISTS (
            SELECT 1 FROM kanban_associations a
             WHERE a.history_id = ? AND a.brief_id = bt.brief_id AND a.task_id = bt.task_id AND a.event_id = 0)
          ORDER BY bt.linked_at LIMIT ?`,
      )
      .all(history.id, history.id, TASKS_PER_PASS),
  )
  const source = `kanban:${history.fileIdentity}`
  let edges = 0
  for (const link of pending) {
    const batch = readReviewEvents(hermes, link.task_id)
    // A malformed history is retried on a later pass rather than marked complete.
    if (batch.malformed) continue
    for (const transition of reviewTransitionsFrom(batch.rows)) {
      const done = db.sqlite
        .prepare(
          'SELECT 1 FROM kanban_associations WHERE history_id = ? AND brief_id = ? AND event_id = ?',
        )
        .get(history.id, link.brief_id, transition.eventId)
      if (done) continue
      await sink.submit({
        source: `kanban-attempts:${history.sourceId}`,
        identity: `kanban-assoc:${history.id}:${link.brief_id}:${transition.eventId}:${randomUUID()}`,
        apply: ({ sqlite, now }) => {
          const claimed = sqlite
            .prepare(
              `INSERT INTO kanban_associations (history_id, brief_id, event_id, task_id, applied_at)
               VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
            )
            .run(history.id, link.brief_id, transition.eventId, link.task_id, now)
          if (claimed.changes === 0) return []
          const task = `task:${link.task_id}`
          const review = `review:${link.task_id}`
          recordEdge(
            sqlite,
            link.brief_id,
            // The same edge id the live review projection uses, so the two paths can never double an edge.
            {
              id: `${source}:review-event:${transition.eventId}`,
              kind: transition.kind,
              at: transition.at,
            },
            transition.kind === 'review' ? task : review,
            transition.kind === 'review' ? review : task,
            history.id,
          )
          return emitBriefChange(sqlite, link.brief_id, true)
        },
      })
      edges++
      hooks.afterEdge?.()
    }
    await sink.submit({
      source: `kanban-attempts:${history.sourceId}`,
      identity: `kanban-assoc-done:${history.id}:${link.brief_id}:${link.task_id}:${randomUUID()}`,
      apply: ({ sqlite, now }) => {
        sqlite
          .prepare(
            `INSERT INTO kanban_associations (history_id, brief_id, event_id, task_id, applied_at)
             VALUES (?, ?, 0, ?, ?) ON CONFLICT DO NOTHING`,
          )
          .run(history.id, link.brief_id, link.task_id, now)
        return []
      },
    })
  }
  return edges
}
