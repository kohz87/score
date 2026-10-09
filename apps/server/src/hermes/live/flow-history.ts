import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { emitBriefChange, recordEdge } from '../../domain/briefs.ts'
import { taskHandoffKind } from '../../domain/lanes.ts'
import { currentOnly, stampHistoryId } from '../../domain/ownership.ts'
import type { ObservationSink } from '../port.ts'
import type { TaskEvent } from './kanban.ts'

export interface ReviewTransition {
  taskId: string
  eventId: number
  kind: 'review' | 'sent_back'
  at: string
}

// Keep event kinds at the adapter boundary; activity text may contain arbitrary review feedback. Built from the
// tailed batch only, so each poll costs O(new events) rather than a scan of every task's history.
export function reviewTransitionsFrom(events: readonly TaskEvent[]): ReviewTransition[] {
  return events.flatMap((event): ReviewTransition[] => {
    if (event.kind !== 'review_requested' && event.kind !== 'changes_requested') return []
    // The event names identify the two roles even when no reviewer profile was recorded.
    const roles = { assignee: 'assignee', reviewer: 'reviewer' }
    const from = event.kind === 'review_requested' ? roles.assignee : roles.reviewer
    const to = event.kind === 'review_requested' ? roles.reviewer : roles.assignee
    const kind = taskHandoffKind(from, to, roles)
    if (kind === 'handoff') return []
    return [
      {
        taskId: event.task_id,
        eventId: event.id,
        kind,
        at: new Date(event.created_at * 1000).toISOString(),
      },
    ]
  })
}

export async function projectReviewTransitions(
  sqlite: DatabaseSync,
  sink: ObservationSink,
  source: string,
  transitions: ReviewTransition[],
): Promise<void> {
  for (const transition of transitions) {
    // Only briefs linked in the lineage Score follows get new edges (inert links are displayed, never routed).
    const owned = currentOnly(sqlite, 'history_id')
    const links = z
      .array(z.object({ brief_id: z.string() }))
      .parse(
        sqlite
          .prepare(`SELECT brief_id FROM brief_tasks WHERE task_id = ?${owned.sql}`)
          .all(transition.taskId, ...owned.params),
      )
    for (const { brief_id: briefId } of links) {
      const id = `${source}:review-event:${transition.eventId}`
      if (
        sqlite.prepare('SELECT 1 FROM brief_edges WHERE brief_id = ? AND id = ?').get(briefId, id)
      )
        continue
      await sink.submit({
        source,
        identity: `flow:${briefId}:${transition.eventId}`,
        apply({ sqlite: writer }) {
          const task = `task:${transition.taskId}`
          const review = `review:${transition.taskId}`
          recordEdge(
            writer,
            briefId,
            { id, kind: transition.kind, at: transition.at },
            transition.kind === 'review' ? task : review,
            transition.kind === 'review' ? review : task,
            stampHistoryId(writer),
          )
          return emitBriefChange(writer, briefId, true)
        },
      })
    }
  }
}
