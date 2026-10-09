import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../../../db/index.ts'
import type { ObservationSink } from '../../port.ts'

// Conservative upgrade of associations made before tasks were qualified by a board lineage (design v5 §F). An
// unqualified row is assigned to the current history only when its task exists on the board now and nothing
// contradicts it; everything else stays unqualified and therefore inert (displayed, never routed, parked or released).
// Runs once per history, after its baseline.

const IDS_PER_READ = 200
/** A link made before the task existed cannot be about this task (the id was reused); allow clock skew. */
const SKEW_MS = 2000

interface Candidate {
  table: string
  keys: Record<string, string>
  taskId: string
  /** When Score made the association (ISO). */
  at: string
}

const TABLES: { table: string; keys: string[]; task: string; at: string; where?: string }[] = [
  { table: 'brief_tasks', keys: ['brief_id', 'task_id'], task: 'task_id', at: 'linked_at' },
  { table: 'task_rooms', keys: ['task_id'], task: 'task_id', at: 'created_at' },
  {
    table: 'brief_paused_tasks',
    keys: ['brief_id', 'task_id'],
    task: 'task_id',
    at: 'blocked_at',
  },
  {
    table: 'agent_paused_tasks',
    keys: ['agent_id', 'task_id'],
    task: 'task_id',
    at: 'blocked_at',
  },
  { table: 'team_paused_tasks', keys: ['team_id', 'task_id'], task: 'task_id', at: 'blocked_at' },
  {
    table: 'approvals',
    keys: ['id'],
    task: 'kanban_task_id',
    at: 'created_at',
    where: "origin = 'kanban' AND closed_reason IS NULL",
  },
]

function candidates(sqlite: DatabaseSync): Candidate[] {
  return TABLES.flatMap((spec) => {
    const column = spec.table === 'approvals' ? 'kanban_history_id' : 'history_id'
    const rows = sqlite
      .prepare(
        `SELECT ${[...spec.keys, spec.task, spec.at].join(', ')} FROM ${spec.table}
          WHERE ${column} IS NULL${spec.where ? ` AND ${spec.where}` : ''}`,
      )
      .all() as Record<string, string>[]
    return rows.map((row) => ({
      table: spec.table,
      keys: Object.fromEntries(spec.keys.map((key) => [key, row[key]!])),
      taskId: row[spec.task]!,
      at: row[spec.at]!,
    }))
  })
}

function boardTasks(hermes: DatabaseSync, ids: string[]): Map<string, number> {
  const found = new Map<string, number>()
  for (let offset = 0; offset < ids.length; offset += IDS_PER_READ) {
    const chunk = ids.slice(offset, offset + IDS_PER_READ)
    const rows = hermes
      .prepare(`SELECT id, created_at FROM tasks WHERE id IN (${chunk.map(() => '?').join(', ')})`)
      .all(...chunk)
    for (const row of z.array(z.object({ id: z.string(), created_at: z.int() })).parse(rows))
      found.set(row.id, row.created_at)
  }
  return found
}

/** Returns how many associations were assigned (0 when already done or nothing to do). */
export async function qualifyOwnership(
  db: ScoreDb,
  sink: ObservationSink,
  hermes: DatabaseSync,
  history: { id: string; sourceId: string },
): Promise<number> {
  const done = db.sqlite
    .prepare('SELECT ownership_qualified_at FROM kanban_histories WHERE id = ?')
    .get(history.id) as { ownership_qualified_at: string | null } | undefined
  if (!done || done.ownership_qualified_at !== null) return 0
  const rows = candidates(db.sqlite)
  const created = boardTasks(hermes, [...new Set(rows.map((row) => row.taskId))])
  const assign = rows.filter((row) => {
    const createdAt = created.get(row.taskId)
    if (createdAt === undefined) return false
    // The link predates the task: the id was reused by a different task.
    return !(createdAt * 1000 > Date.parse(row.at) + SKEW_MS)
  })
  let assigned = 0
  await sink.submit({
    source: `kanban-attempts:${history.sourceId}`,
    identity: `kanban:ownership:${history.id}:${randomUUID()}`,
    apply: ({ sqlite, now }) => {
      const state = sqlite
        .prepare('SELECT state, ownership_qualified_at FROM kanban_histories WHERE id = ?')
        .get(history.id) as { state: string; ownership_qualified_at: string | null } | undefined
      if (!state || state.state !== 'active' || state.ownership_qualified_at !== null) return []
      for (const row of assign) {
        const column = row.table === 'approvals' ? 'kanban_history_id' : 'history_id'
        const where = Object.keys(row.keys)
          .map((key) => `${key} = ?`)
          .join(' AND ')
        assigned += Number(
          sqlite
            .prepare(`UPDATE ${row.table} SET ${column} = ? WHERE ${where} AND ${column} IS NULL`)
            .run(history.id, ...Object.values(row.keys)).changes,
        )
      }
      sqlite
        .prepare('UPDATE kanban_histories SET ownership_qualified_at = ? WHERE id = ?')
        .run(now, history.id)
      return []
    },
  })
  return assigned
}
