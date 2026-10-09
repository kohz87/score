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
import { readReviewEvents, tailTaskEvents, type TaskEvent } from './kanban.ts'
import { eventActivity, readTaskDetails } from './task-model.ts'
import {
  projectReviewTransitions,
  reviewTransitionsFrom,
  type ReviewTransition,
} from './flow-history.ts'
import { createTailer } from './tailer.ts'
import { hermesPaths, resolveHermesHome } from './paths.ts'
import { incarnationOf, HermesDbMissing } from './sqlite.ts'
import { currentOnly, liveHistory, stampHistoryId } from '../../domain/ownership.ts'
import { KanbanAttemptsCoordinator } from './kanban-attempts/coordinator.ts'
import { kanbanAttemptsEnabled } from './kanban-attempts/types.ts'

export class LiveTasks {
  private readonly tailer
  private flight: Promise<void> | undefined
  private readonly path: string
  /** Kanban attempts projection (5.17a-1), next to the task projection; off unless SCORE_KANBAN_ATTEMPTS=1. */
  readonly attempts: KanbanAttemptsCoordinator | undefined
  constructor(
    private readonly db: ScoreDb,
    private readonly sink: ObservationSink,
    hermesHome?: string,
    options: { kanbanAttempts?: boolean } = {},
  ) {
    this.path = hermesPaths(resolveHermesHome(hermesHome)).kanbanDb
    this.attempts =
      (options.kanbanAttempts ?? kanbanAttemptsEnabled())
        ? new KanbanAttemptsCoordinator({ db, sink, path: this.path })
        : undefined
    this.tailer = createTailer<TaskEvent>({
      path: this.path,
      scope: 'tasks',
      idOf: (event) => event.id,
      read: (sqlite, afterId, limit) => {
        sqlite.exec('BEGIN')
        try {
          const batch = tailTaskEvents(sqlite, { afterId, limit })
          const tasks = this.withRooms(readTaskDetails(sqlite))
          const reviews = reviewTransitionsFrom(batch.rows)
          // A task linked to a brief after its review events went past the tailer still needs its edges: read the
          // history of newly linked tasks once (by id), never the whole board.
          for (const taskId of this.linkedTaskIds()) {
            if (this.backfilled.has(taskId)) continue
            const history = readReviewEvents(sqlite, taskId)
            if (history.malformed) continue
            reviews.push(...reviewTransitionsFrom(history.rows))
            this.backfilled.add(taskId)
          }
          sqlite.exec('COMMIT')
          this.latest = tasks
          // A poll can read several batches; keep every batch's transitions until they're projected.
          this.reviews.push(...reviews)
          return batch
        } catch (error) {
          sqlite.exec('ROLLBACK')
          throw error
        }
      },
    })
  }
  /** Room links are Score's own (task_rooms); Hermes tasks carry none. */
  private withRooms(tasks: TaskDetail[]): TaskDetail[] {
    const rooms = new Map(
      z
        .array(z.object({ task_id: z.string(), room_id: z.string() }))
        .parse(this.db.sqlite.prepare('SELECT task_id, room_id FROM task_rooms').all())
        .map((row) => [row.task_id, row.room_id]),
    )
    return tasks.map((task) => ({ ...task, roomId: rooms.get(task.id) ?? null }))
  }
  private latest: TaskDetail[] = []
  private reviews: ReviewTransition[] = []
  private readonly backfilled = new Set<string>()
  private lastSuffix = ''
  private linkedTaskIds(): string[] {
    // With attempts on, only links made in the followed history get review edges (inert ones are display-only).
    const owned = this.attempts
      ? currentOnly(this.db.sqlite, 'history_id')
      : { sql: '', params: [] }
    return z
      .array(z.object({ task_id: z.string() }))
      .parse(
        this.db.sqlite
          .prepare(`SELECT DISTINCT task_id FROM brief_tasks WHERE 1 = 1${owned.sql}`)
          .all(...owned.params),
      )
      .map((row) => row.task_id)
  }

  poll(): Promise<void> {
    this.flight ??= this.pollAll().finally(() => {
      this.flight = undefined
    })
    return this.flight
  }
  private async pollAll(): Promise<void> {
    if (!this.attempts) {
      await this.pollOnce()
      return
    }
    try {
      // First: the history decision and the upgrade snapshot of legacy links must come before any task
      // reconciliation can rewrite a projection. The projections are independent: a failure in one never starves
      // the other.
      await this.attempts.poll()
    } finally {
      await this.pollOnce()
    }
  }
  /** The task cursors, identities and revisions of one board lineage (5.17a-1); '' without attempts. */
  private scopeSuffix(): string {
    if (!this.attempts) return ''
    const live = liveHistory(this.db.sqlite)
    if (!live) return ''
    const first = this.db.sqlite
      .prepare(
        `SELECT id FROM kanban_histories
         WHERE source_id = (SELECT source_id FROM kanban_histories WHERE id = ?)
         ORDER BY opened_at, rowid LIMIT 1`,
      )
      .get(live.id) as { id: string } | undefined
    // The first lineage inherits the checkpoints made before attempts were enabled.
    return first === undefined || first.id === live.id ? '' : `:${live.id}`
  }
  private async pollOnce(): Promise<void> {
    let incarnation: string
    try {
      incarnation = incarnationOf(this.path)
    } catch (error) {
      if (error instanceof HermesDbMissing) return
      throw error
    }
    const suffix = this.scopeSuffix()
    if (suffix !== this.lastSuffix) {
      this.lastSuffix = suffix
      this.backfilled.clear()
      this.reviews.length = 0
    }
    let source = `kanban:${incarnation}${suffix}`
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
    source = `kanban:${incarnation}${suffix}`
    // Revisions are event ids: a restored board starts them over, so they are compared within one lineage only.
    const revisionScope = `${incarnation}${suffix}`
    const byId = new Map(this.latest.map((task) => [task.id, task]))
    for (const event of batch.rows) {
      const task = byId.get(event.task_id)
      await this.sink.submit({
        source,
        identity: `kanban-event:${event.id}`,
        checkpoint: { ...batch.checkpoint, position: event.id },
        apply: ({ sqlite }) => {
          if (!task) return []
          const applied = projectTask(sqlite, task, event.id, revisionScope)
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
    await this.restamp(source, byId)
    const reviews = this.reviews.splice(0)
    await projectReviewTransitions(this.db.sqlite, this.sink, source, reviews)
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
          if (projectTask(sqlite, task, batch.checkpoint.position, revisionScope))
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
  /**
   * Projections written before a lineage was verified, or from one that was replaced, carry no stamp for the lineage
   * Score follows now. The ones the board still has are restamped (5.17a-1); the others are removed by reconciliation.
   */
  private async restamp(source: string, onBoard: Map<string, TaskDetail>): Promise<void> {
    if (!this.attempts) return
    const stamp = stampHistoryId(this.db.sqlite)
    if (stamp === null) return
    const ids = z
      .array(z.object({ id: z.string() }))
      .parse(
        this.db.sqlite
          .prepare('SELECT id FROM task_projections WHERE history_id IS NOT ?')
          .all(stamp),
      )
      .map((row) => row.id)
      .filter((id) => onBoard.has(id))
    if (!ids.length) return
    await this.sink.submit({
      source,
      identity: `restamp:${randomUUID()}`,
      apply: ({ sqlite }) => {
        const update = sqlite.prepare(
          'UPDATE task_projections SET history_id = ? WHERE id = ? AND history_id IS NOT ?',
        )
        for (const id of ids) update.run(stamp, id, stamp)
        return []
      },
    })
  }
  async close(): Promise<void> {
    await this.flight
    await this.attempts?.close()
    this.tailer.close()
  }
}
