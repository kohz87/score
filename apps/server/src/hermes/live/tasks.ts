import { randomUUID } from 'node:crypto'
import type { TaskDetail } from '@score/contract'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import {
  projectTask,
  readProjectedTask,
  taskSummary,
  taskWithApproval,
} from '../../domain/tasks.ts'
import type { ObservationSink } from '../port.ts'
import { tailTaskEvents, type TaskEvent } from './kanban.ts'
import { eventActivity, readTaskDetails } from './task-model.ts'
import { createTailer } from './tailer.ts'
import { hermesPaths, resolveHermesHome } from './paths.ts'
import { incarnationOf, HermesDbMissing } from './sqlite.ts'

export class LiveTasks {
  private readonly tailer
  private flight: Promise<void> | undefined
  private readonly path: string
  constructor(
    private readonly db: ScoreDb,
    private readonly sink: ObservationSink,
    hermesHome?: string,
  ) {
    this.path = hermesPaths(resolveHermesHome(hermesHome)).kanbanDb
    this.tailer = createTailer<TaskEvent>({
      path: this.path,
      scope: 'tasks',
      idOf: (event) => event.id,
      read: (sqlite, afterId, limit) => {
        sqlite.exec('BEGIN')
        try {
          const batch = tailTaskEvents(sqlite, { afterId, limit })
          const tasks = readTaskDetails(sqlite)
          sqlite.exec('COMMIT')
          this.latest = tasks
          return batch
        } catch (error) {
          sqlite.exec('ROLLBACK')
          throw error
        }
      },
    })
  }
  private latest: TaskDetail[] = []

  poll(): Promise<void> {
    this.flight ??= this.pollOnce().finally(() => {
      this.flight = undefined
    })
    return this.flight
  }
  private async pollOnce(): Promise<void> {
    let incarnation: string
    try {
      incarnation = incarnationOf(this.path)
    } catch (error) {
      if (error instanceof HermesDbMissing) return
      throw error
    }
    let source = `kanban:${incarnation}`
    const row = this.db.sqlite
      .prepare('SELECT cursor, incarnation FROM ingest_checkpoints WHERE source = ? AND scope = ?')
      .get(source, 'tasks')
    const stored = row
      ? z
          .object({
            cursor: z.coerce.number().int().nonnegative(),
            incarnation: z.string().nullable(),
          })
          .parse(row)
      : undefined
    const batch = this.tailer.poll(
      stored ? { position: stored.cursor, incarnation: stored.incarnation } : undefined,
    )
    if (batch.missing) return
    incarnation = batch.checkpoint.incarnation!
    source = `kanban:${incarnation}`
    const byId = new Map(this.latest.map((task) => [task.id, task]))
    for (const event of batch.rows) {
      const task = byId.get(event.task_id)
      await this.sink.submit({
        source,
        identity: `kanban-event:${event.id}`,
        checkpoint: { ...batch.checkpoint, position: event.id },
        apply: ({ sqlite }) => {
          if (!task) return []
          const applied = projectTask(sqlite, task, event.id, incarnation)
          return [
            ...(applied
              ? [
                  {
                    type: 'task.upserted' as const,
                    data: taskSummary(taskWithApproval(sqlite, task)),
                  },
                ]
              : []),
            {
              type: 'task.activity' as const,
              data: { taskId: task.id, item: eventActivity(event) },
            },
          ]
        },
      })
    }
    // Mutable fields and tasks without events still need a baseline/reconciliation observation.
    const changed = this.latest.filter((task) => {
      const old = readProjectedTask(this.db.sqlite, task.id)
      return (
        !old ||
        JSON.stringify({ ...old, elapsedSec: null }) !==
          JSON.stringify({ ...task, elapsedSec: null })
      )
    })
    const removed = z
      .array(z.object({ id: z.string() }))
      .parse(
        this.db.sqlite
          .prepare('SELECT id FROM task_projections WHERE incarnation IS NOT NULL')
          .all(),
      )
      .filter((row) => !byId.has(row.id))
    if (
      !changed.length &&
      !removed.length &&
      (batch.checkpoint.position === (stored?.cursor ?? 0) ||
        batch.rows.at(-1)?.id === batch.checkpoint.position)
    )
      return
    await this.sink.submit({
      source,
      identity: `reconcile:${randomUUID()}`,
      checkpoint: batch.checkpoint,
      apply: ({ sqlite }) => {
        const drafts = []
        for (const task of changed) {
          const old = readProjectedTask(sqlite, task.id)
          if (
            old &&
            JSON.stringify({ ...old, elapsedSec: null }) ===
              JSON.stringify({ ...task, elapsedSec: null })
          )
            continue
          if (projectTask(sqlite, task, batch.checkpoint.position, incarnation))
            drafts.push({
              type: 'task.upserted' as const,
              data: taskSummary(taskWithApproval(sqlite, task)),
            })
        }
        for (const row of removed) {
          const task = readProjectedTask(sqlite, row.id)
          if (!task) continue
          sqlite.prepare('DELETE FROM task_projections WHERE id = ?').run(row.id)
          drafts.push({
            type: 'task.upserted' as const,
            data: taskSummary({
              ...task,
              hermesStatus: 'archived',
              column: 'done',
              badge: null,
              progress: null,
            }),
          })
        }
        return drafts
      },
    })
  }
  async close(): Promise<void> {
    await this.flight
    this.tailer.close()
  }
}
