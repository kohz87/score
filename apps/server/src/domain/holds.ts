import type { DatabaseSync } from 'node:sqlite'
import { currentOnly, stampHistoryId } from './ownership.ts'

/** Statuses Score parks. Triage is not dispatchable, and anything else has started or moved on. */
export const PARKABLE = ['ready', 'todo']

/** `team` has one owner (id `team`): the holds for tasks that arrive while everyone is paused. */
export type HoldOwner = { kind: 'brief' | 'agent' | 'team'; id: string }
export const HOLD_KINDS = ['brief', 'agent', 'team'] as const

export const TABLES = {
  brief: { table: 'brief_paused_tasks', column: 'brief_id' },
  agent: { table: 'agent_paused_tasks', column: 'agent_id' },
  team: { table: 'team_paused_tasks', column: 'team_id' },
} as const

/** Whether any hold (any owner, any state) other than `except` still wants the task parked. */
export function otherHold(sqlite: DatabaseSync, taskId: string, except: HoldOwner): boolean {
  return HOLD_KINDS.some((kind) => {
    const { table, column } = TABLES[kind]
    const exclude = kind === except.kind ? `AND ${column} <> ?` : ''
    // A hold from another board lineage (inert) does not keep this lineage's task parked.
    const owned = currentOnly(sqlite, 'history_id')
    return (
      sqlite
        .prepare(`SELECT 1 FROM ${table} WHERE task_id = ? ${exclude}${owned.sql}`)
        .get(...(kind === except.kind ? [taskId, except.id] : [taskId]), ...owned.params) !==
      undefined
    )
  })
}

export function anyHold(sqlite: DatabaseSync, taskId: string): boolean {
  return otherHold(sqlite, taskId, { kind: 'brief', id: '\0' })
}

/** Not-started tasks a pause should hold: parkable now, or already parked by another hold. */
export function holdable(sqlite: DatabaseSync, taskId: string, status: string): boolean {
  return PARKABLE.includes(status) || (status === 'scheduled' && anyHold(sqlite, taskId))
}

/** Records the intent in the caller's transaction (before Hermes is touched). Existing rows keep their state. */
export function recordHolds(
  sqlite: DatabaseSync,
  owner: HoldOwner,
  taskIds: string[],
  now: string,
): void {
  const { table, column } = TABLES[owner.kind]
  const historyId = stampHistoryId(sqlite)
  for (const taskId of taskIds)
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO ${table} (${column}, task_id, blocked_at, state, history_id) VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(owner.id, taskId, now, historyId)
}
