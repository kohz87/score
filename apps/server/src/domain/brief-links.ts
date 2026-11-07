import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { stampHistoryId } from './ownership.ts'
import { briefTitle } from './brief-queries.ts'
import { IdRowSchema, type BriefTaskOrigin } from './brief-types.ts'
import { emitBrief } from './brief-status.ts'
import { recordArrivalHolds } from './brief-holds.ts'

export function createBrief(
  sqlite: DatabaseSync,
  req: {
    id: string
    roomId: string
    text: string
    startedBy?: string
    startedAt?: string
    tasks?: { taskId: string; origin: BriefTaskOrigin }[]
  },
  now: string,
): DomainEventDraft[] {
  const inserted = sqlite
    .prepare(
      `INSERT INTO briefs (id, room_id, title, started_at, started_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(req.id, req.roomId, briefTitle(req.text), req.startedAt ?? now, req.startedBy ?? 'you')
  if (!inserted.changes) return []
  linkTasks(sqlite, req.id, req.tasks ?? [], now)
  return emitBrief(sqlite, req.id, true)
}

/** Records exact task links first, then any Kanban children already known (so an explicit origin wins). */
export function linkTasks(
  sqlite: DatabaseSync,
  briefId: string,
  tasks: { taskId: string; origin: BriefTaskOrigin }[],
  now: string,
): void {
  const fresh = tasks.filter(({ taskId, origin }) =>
    Boolean(
      sqlite
        .prepare(
          `INSERT INTO brief_tasks (brief_id, task_id, origin, linked_at, history_id) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(briefId, taskId, origin, now, stampHistoryId(sqlite)).changes,
    ),
  )
  for (const { taskId } of fresh) linkDescendants(sqlite, briefId, taskId, now)
  // A task can arrive before its link (Start plan links after Hermes created it); if the brief was paused in
  // between, the arrival hook found nothing to hold.
  recordArrivalHolds(
    sqlite,
    fresh.map(({ taskId }) => taskId),
    now,
  )
}

export const linkTask = (
  sqlite: DatabaseSync,
  briefId: string,
  taskId: string,
  origin: BriefTaskOrigin,
  now: string,
) => linkTasks(sqlite, briefId, [{ taskId, origin }], now)

// Kanban `--parent` edges: a task that depends on a brief task is that task's child.
function linkDescendants(sqlite: DatabaseSync, briefId: string, taskId: string, now: string) {
  const children = z.array(IdRowSchema).parse(
    sqlite
      .prepare(
        `SELECT id FROM task_projections WHERE EXISTS
           (SELECT 1 FROM json_each(json_extract(detail, '$.dependsOn')) WHERE value = ?)`,
      )
      .all(taskId),
  )
  linkTasks(
    sqlite,
    briefId,
    children.map((child) => ({ taskId: child.id, origin: 'child' as const })),
    now,
  )
}

export function recordEdge(
  sqlite: DatabaseSync,
  briefId: string,
  handoff: { id: string; kind: 'handoff' | 'review' | 'sent_back'; at: string },
  from: string,
  to: string,
  /** Review edges read from a Kanban board carry the lineage they came from (5.17a-1). */
  historyId: string | null = null,
): void {
  sqlite
    .prepare(
      `INSERT INTO brief_edges (brief_id, id, kind, from_block, to_block, at, history_id) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(briefId, handoff.id, handoff.kind, from, to, handoff.at, historyId)
}
