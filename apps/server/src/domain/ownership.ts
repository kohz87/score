import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { kanbanAttemptsEnabled } from './kanban-attempts.ts'

// Qualified ownership (5.17a-1 stage 2a, design v5 §F). Every Score-side association of a Kanban task (brief link,
// room link, pause hold, review edge, denial) carries the board lineage it was made in. With the attempts
// projection off nothing here has an effect: rows are written unstamped and every row counts as owned.

const HistoryRowSchema = z.object({ id: z.string(), state: z.enum(['active', 'paused']) })

/** The lineage Score follows right now (active or paused), or null before one exists or when attempts are off. */
export function liveHistory(
  sqlite: DatabaseSync,
  enabled = kanbanAttemptsEnabled(),
): { id: string; state: 'active' | 'paused' } | null {
  if (!enabled) return null
  const row = sqlite
    .prepare("SELECT id, state FROM kanban_histories WHERE state != 'closed' LIMIT 1")
    .get()
  return row === undefined ? null : HistoryRowSchema.parse(row)
}

/** What to stamp on a new association: the live lineage, or null when there is none (the row stays unqualified). */
export function stampHistoryId(sqlite: DatabaseSync): string | null {
  return liveHistory(sqlite)?.id ?? null
}

/** The lineage whose associations may be routed, parked or released: the live one, and only while it is verified. */
export function actionableHistoryId(sqlite: DatabaseSync): string | null {
  const live = liveHistory(sqlite)
  return live?.state === 'active' ? live.id : null
}

/**
 * `current` rows may be routed, parked and released. `inert` rows (unqualified, from another lineage, or while the
 * source is paused or unverified) are still displayed, but never acted on. With attempts off every row is current.
 */
export function ownershipOf(
  sqlite: DatabaseSync,
  rowHistoryId: string | null,
): 'current' | 'inert' {
  if (!kanbanAttemptsEnabled()) return 'current'
  const actionable = actionableHistoryId(sqlite)
  return actionable !== null && rowHistoryId === actionable ? 'current' : 'inert'
}

/**
 * SQL that keeps only the rows of `column` that are current (empty when attempts are off). With attempts on and no
 * actionable lineage nothing matches.
 */
export function currentOnly(
  sqlite: DatabaseSync,
  column: string,
): { sql: string; params: string[] } {
  if (!kanbanAttemptsEnabled()) return { sql: '', params: [] }
  const actionable = actionableHistoryId(sqlite)
  return actionable === null
    ? { sql: ` AND 0`, params: [] }
    : { sql: ` AND ${column} = ?`, params: [actionable] }
}
