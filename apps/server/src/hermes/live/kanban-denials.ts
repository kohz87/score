import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Config } from '../../config.ts'
import type { ScoreDb } from '../../db/index.ts'
import { closeKanbanDenials, type KanbanTaskState } from '../../domain/kanban-denials.ts'
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
  if (!tasks.length) return
  await sink.submit({
    source: 'kanban-denial-sweep',
    identity: randomUUID(),
    apply: ({ sqlite, now }) => closeKanbanDenials(sqlite, tasks, now),
  })
}
