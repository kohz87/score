import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Config } from '../../config.ts'
import type { ScoreDb } from '../../db/index.ts'
import { closeKanbanDenials, obsolete, type KanbanTaskState } from '../../domain/kanban-denials.ts'
import type { ObservationSink } from '../port.ts'
import { readTasks } from './kanban.ts'
import { hermesPaths, resolveHermesHome } from './paths.ts'
import { openReadOnly } from './sqlite.ts'

export async function sweepKanbanDenials(
  db: ScoreDb,
  sink: ObservationSink,
  config: Pick<Config, 'hermesHome'> = {},
): Promise<void> {
  const ids = z
    .array(z.object({ kanban_task_id: z.string() }))
    .parse(
      db.sqlite
        .prepare(
          `SELECT DISTINCT kanban_task_id FROM approvals WHERE origin = 'kanban' AND closed_reason IS NULL`,
        )
        .all(),
    )
    .map((row) => row.kanban_task_id)
  if (!ids.length) return
  const hermes = openReadOnly(hermesPaths(resolveHermesHome(config.hermesHome)).kanbanDb)
  let tasks: KanbanTaskState[]
  try {
    // Missing or malformed rows are not evidence of a transition.
    tasks = readTasks(hermes, ids).rows.map(({ id, status, current_run_id }) => ({
      id,
      status,
      current_run_id,
    }))
  } finally {
    hermes.close()
  }
  const open = z
    .array(z.object({ kanban_task_id: z.string(), kanban_run_id: z.int().nullable() }))
    .parse(
      db.sqlite
        .prepare(
          "SELECT kanban_task_id, kanban_run_id FROM approvals WHERE origin = 'kanban' AND closed_reason IS NULL",
        )
        .all(),
    )
  tasks = tasks.filter((task) =>
    open.some((row) => row.kanban_task_id === task.id && obsolete(row.kanban_run_id, task)),
  )
  if (!tasks.length) return
  await sink.submit({
    source: 'kanban-denial-sweep',
    identity: randomUUID(),
    apply: ({ sqlite, now }) => closeKanbanDenials(sqlite, tasks, now),
  })
}
