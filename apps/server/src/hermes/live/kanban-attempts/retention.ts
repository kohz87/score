import type { ScoreDb } from '../../../db/index.ts'
import { PAGE_RETENTION_MS } from './types.ts'

// Events behind the cursor are only ever re-seen through a retried page, which is far shorter than this.
const SEEN_EVENT_WINDOW = 50_000

export interface KanbanRetentionResult {
  pages: number
  seenEvents: number
}

/**
 * Hourly pass. Page rows are retry identities only, so they go after 7 days -- except the newest page of each kind
 * of a live history, which is the resume point of a capture that may still be open (v5.1 #3).
 */
export function pruneKanbanAttempts(db: ScoreDb, now = Date.now()): KanbanRetentionResult {
  const cutoff = new Date(now - PAGE_RETENTION_MS).toISOString()
  return db.tx((sqlite) => {
    const pages = sqlite
      .prepare(
        `DELETE FROM kanban_pages
          WHERE captured_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM kanban_histories h
               WHERE h.id = kanban_pages.history_id AND h.state != 'closed'
                 AND kanban_pages.rowid = (
                   SELECT MAX(p.rowid) FROM kanban_pages p
                    WHERE p.history_id = kanban_pages.history_id AND p.kind = kanban_pages.kind)
            )`,
      )
      .run(cutoff)
    const closed = sqlite
      .prepare(
        `DELETE FROM kanban_seen_events
          WHERE history_id IN (SELECT id FROM kanban_histories WHERE state = 'closed')`,
      )
      .run()
    const behind = sqlite
      .prepare(
        `DELETE FROM kanban_seen_events
          WHERE event_id < (SELECT event_cursor FROM kanban_histories h WHERE h.id = kanban_seen_events.history_id) - ?`,
      )
      .run(SEEN_EVENT_WINDOW)
    return {
      pages: Number(pages.changes),
      seenEvents: Number(closed.changes) + Number(behind.changes),
    }
  })
}
