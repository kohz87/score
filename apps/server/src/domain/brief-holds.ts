import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { holdable, recordHolds, type HoldOwner } from './holds.ts'
import { currentOnly, ownershipOf } from './ownership.ts'
import { teamPausedAt } from './team-pause.ts'
import { projectedDetail, taskStatus } from './brief-queries.ts'

/**
 * Pause covers tasks that arrive later: a task linked to a paused brief, assigned to a paused agent, or seen while
 * the team is paused gets a pending hold per paused owner, in the observation's own transaction. The server parks
 * them after the commit (task-holds.ts), and recovery finishes them after a crash.
 */
export function recordArrivalHolds(
  sqlite: DatabaseSync,
  taskIds: Iterable<string>,
  now: string,
): void {
  const teamPaused = teamPausedAt(sqlite) !== null
  for (const taskId of taskIds) {
    const detail = projectedDetail(sqlite, taskId)
    if (!detail || !holdable(sqlite, taskId, taskStatus(detail))) continue
    // A task whose projection is not owned by the followed board lineage is never parked (inert, 5.17a-1).
    const owner = sqlite
      .prepare('SELECT history_id FROM task_projections WHERE id = ?')
      .get(taskId) as { history_id: string | null } | undefined
    if (ownershipOf(sqlite, owner?.history_id ?? null) === 'inert') continue
    const links = currentOnly(sqlite, 'b.history_id')
    const owners: HoldOwner[] = z
      .array(z.object({ brief_id: z.string() }))
      .parse(
        sqlite
          .prepare(
            `SELECT b.brief_id FROM brief_tasks b JOIN briefs r ON r.id = b.brief_id
             WHERE b.task_id = ? AND r.paused_at IS NOT NULL${links.sql}`,
          )
          .all(taskId, ...links.params),
      )
      .map((row) => ({ kind: 'brief', id: row.brief_id }))
    if (
      detail.assignee &&
      sqlite.prepare('SELECT 1 FROM agent_pauses WHERE agent_id = ?').get(detail.assignee) !==
        undefined
    )
      owners.push({ kind: 'agent', id: detail.assignee })
    if (teamPaused) owners.push({ kind: 'team', id: 'team' })
    for (const owner of owners) recordHolds(sqlite, owner, [taskId], now)
  }
}
