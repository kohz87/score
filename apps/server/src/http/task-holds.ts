import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { taskStatus } from '../domain/briefs.ts'
import { HOLD_KINDS, otherHold, PARKABLE, TABLES, type HoldOwner } from '../domain/holds.ts'
import { currentOnly, ownershipOf } from '../domain/ownership.ts'
import { kanbanAttemptsEnabled } from '../domain/kanban-attempts.ts'

const PAUSE_REASON = 'Paused from Score'
const RESUME_REASON = 'Resumed from Score'

const StateRow = z.object({ state: z.enum(['pending', 'held']) })
const TaskRow = z.object({ task_id: z.string() })
const OwnerRow = z.object({ owner: z.string() })

export interface TaskHolds {
  /** Parks every pending hold of the owner. Returns the tasks Hermes would not park (they stay pending). */
  apply(owner: HoldOwner, stillPaused: () => boolean): Promise<string[]>
  /** Drops the owner's holds and unparks each task whose last hold this was. Returns the tasks that failed. */
  release(owner: HoldOwner): Promise<string[]>
  /**
   * Finishes holds a crash left half-done: parks pending holds of paused owners and releases every hold of owners
   * that are no longer paused. Returns how many tasks still need another attempt.
   */
  recover(isPaused: (owner: HoldOwner) => boolean): Promise<number>
  /** Parks the pending holds of paused owners only (tasks that arrived after a Pause). Returns the failures. */
  applyPending(isPaused: (owner: HoldOwner) => boolean): Promise<number>
}

/**
 * Pause is a set of independent holds (per brief, per agent) on Kanban tasks. A task is parked in Hermes'
 * `scheduled` status (not `blocked`: that counts toward Hermes's unblock-loop breaker and would send a
 * twice-paused task to triage) and unparked only when its last hold goes. Operations on one task are serialized
 * here, so Resume cannot interleave with a Pause still in flight.
 */
export function createTaskHolds(deps: {
  port: HermesPort
  db: ScoreDb
  ingest: Ingest
  /** Holds Score will not release (5.17a-1): they belong to another board lineage or an unverified one. */
  onInert?: (owner: HoldOwner, taskIds: string[]) => void
}): TaskHolds {
  const { port, db, ingest, onInert } = deps
  const tails = new Map<string, Promise<unknown>>()

  function locked<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const run = (tails.get(taskId) ?? Promise.resolve()).then(work, work)
    const tail = run.catch(() => undefined)
    tails.set(taskId, tail)
    void tail.then(() => {
      if (tails.get(taskId) === tail) tails.delete(taskId)
    })
    return run
  }

  const stateOf = (owner: HoldOwner, taskId: string) =>
    db.read((sqlite) => {
      const { table, column } = TABLES[owner.kind]
      const row = sqlite
        .prepare(`SELECT state FROM ${table} WHERE ${column} = ? AND task_id = ?`)
        .get(owner.id, taskId)
      return row === undefined ? undefined : StateRow.parse(row).state
    })

  const write = (apply: (sqlite: DatabaseSync) => void) =>
    ingest.submit({
      source: 'task-holds',
      identity: randomUUID(),
      apply({ sqlite }) {
        apply(sqlite)
        return []
      },
    })

  const drop = (owner: HoldOwner, taskId: string) =>
    write((sqlite) => {
      const { table, column } = TABLES[owner.kind]
      sqlite
        .prepare(`DELETE FROM ${table} WHERE ${column} = ? AND task_id = ?`)
        .run(owner.id, taskId)
    })

  const confirm = (owner: HoldOwner, taskId: string) =>
    write((sqlite) => {
      const { table, column } = TABLES[owner.kind]
      sqlite
        .prepare(`UPDATE ${table} SET state = 'held' WHERE ${column} = ? AND task_id = ?`)
        .run(owner.id, taskId)
    })

  const legacyOf = (owner: HoldOwner, taskId: string) =>
    db.read((sqlite) => {
      const { table, column } = TABLES[owner.kind]
      return (
        sqlite
          .prepare(
            `SELECT 1 FROM ${table} WHERE ${column} = ? AND task_id = ? AND legacy = 1 AND state = 'held'`,
          )
          .get(owner.id, taskId) !== undefined
      )
    })

  const taskOf = (taskId: string) =>
    port.getTask(taskId).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 404) return undefined
      throw error
    })

  async function releaseOne(owner: HoldOwner, taskId: string): Promise<void> {
    if (stateOf(owner, taskId) === undefined) return
    const task = await taskOf(taskId)
    const last = !db.read((sqlite) => otherHold(sqlite, taskId, owner))
    // Only what Score parked, and only if it is still parked (the person may have moved it since). Holds from before
    // tasks were parked as `scheduled` (legacy) parked them as `blocked`.
    const parked = task ? taskStatus(task) : undefined
    if (
      task &&
      last &&
      (parked === 'scheduled' || (parked === 'blocked' && legacyOf(owner, taskId)))
    )
      await port.taskAction({ taskId, action: 'unblock', text: RESUME_REASON })
    await drop(owner, taskId)
  }

  async function applyOne(
    owner: HoldOwner,
    taskId: string,
    stillPaused: () => boolean,
  ): Promise<boolean> {
    if (stateOf(owner, taskId) !== 'pending') return true
    // A Resume that ran first has already cleared the owner: nothing may stay parked for it.
    if (!stillPaused()) {
      await releaseOne(owner, taskId)
      return true
    }
    const task = await taskOf(taskId)
    if (!task) {
      await drop(owner, taskId)
      return true
    }
    // A fresh read, not the projection: a task that has started since the pause began is left to finish.
    if (taskStatus(task) === 'scheduled') {
      await confirm(owner, taskId)
      return true
    }
    if (!PARKABLE.includes(taskStatus(task))) {
      await drop(owner, taskId)
      return true
    }
    try {
      const { hermesStatus } = await port.taskAction({
        taskId,
        action: 'schedule',
        text: PAUSE_REASON,
      })
      if (hermesStatus !== 'scheduled') return false
    } catch {
      // Refused because the task moved on (started, finished, archived): nothing to hold any more. If the read that
      // tells us so fails too, the outcome is unknown: the intent stays pending and the caller sees a failure.
      const now = await taskOf(taskId)
      if (now && (PARKABLE.includes(taskStatus(now)) || taskStatus(now) === 'scheduled'))
        return false
      await drop(owner, taskId)
      return true
    }
    await confirm(owner, taskId)
    return true
  }

  // Only holds owned by the followed board lineage are parked or released; the rest are inert (5.17a-1).
  const taskIdsOf = (owner: HoldOwner, pendingOnly: boolean) =>
    db.read((sqlite) => {
      const { table, column } = TABLES[owner.kind]
      const owned = currentOnly(sqlite, 'history_id')
      return z
        .array(TaskRow)
        .parse(
          sqlite
            .prepare(
              `SELECT task_id FROM ${table} WHERE ${column} = ? ${pendingOnly ? "AND state = 'pending'" : ''}${owned.sql} ORDER BY rowid`,
            )
            .all(owner.id, ...owned.params),
        )
        .map((row) => row.task_id)
    })

  const inertTaskIds = (owner: HoldOwner): string[] =>
    !kanbanAttemptsEnabled()
      ? []
      : db.read((sqlite) => {
          const { table, column } = TABLES[owner.kind]
          return z
            .array(z.object({ task_id: z.string(), history_id: z.string().nullable() }))
            .parse(
              sqlite
                .prepare(
                  `SELECT task_id, history_id FROM ${table} WHERE ${column} = ? ORDER BY rowid`,
                )
                .all(owner.id),
            )
            .filter((row) => ownershipOf(sqlite, row.history_id) === 'inert')
            .map((row) => row.task_id)
        })

  async function each(
    taskIds: string[],
    one: (taskId: string) => Promise<boolean>,
  ): Promise<string[]> {
    const failed: string[] = []
    for (const taskId of taskIds) {
      try {
        if (!(await locked(taskId, () => one(taskId)))) failed.push(taskId)
      } catch {
        failed.push(taskId)
      }
    }
    return failed
  }

  const owners = (pendingOnly: boolean) =>
    db.read((sqlite) =>
      HOLD_KINDS.flatMap((kind) => {
        const { table, column } = TABLES[kind]
        return z
          .array(OwnerRow)
          .parse(
            sqlite
              .prepare(
                `SELECT DISTINCT ${column} AS owner FROM ${table} ${pendingOnly ? "WHERE state = 'pending'" : ''}`,
              )
              .all(),
          )
          .map((row): HoldOwner => ({ kind, id: row.owner }))
      }),
    )

  const holds: TaskHolds = {
    apply: (owner, stillPaused) =>
      each(taskIdsOf(owner, true), (taskId) => applyOne(owner, taskId, stillPaused)),
    release: async (owner) => {
      const failed = await each(taskIdsOf(owner, false), async (taskId) => {
        await releaseOne(owner, taskId)
        return true
      })
      // Inert holds are skipped, not dropped and not failures: Resume must not unpark another lineage's task.
      const inert = inertTaskIds(owner)
      if (inert.length) onInert?.(owner, inert)
      return failed
    },
    async recover(isPaused) {
      let unresolved = 0
      for (const owner of owners(false)) {
        const failed = await (isPaused(owner)
          ? holds.apply(owner, () => isPaused(owner))
          : holds.release(owner))
        unresolved += failed.length
      }
      return unresolved
    },
    async applyPending(isPaused) {
      let unresolved = 0
      for (const owner of owners(true))
        if (isPaused(owner)) unresolved += (await holds.apply(owner, () => isPaused(owner))).length
      return unresolved
    },
  }
  return holds
}
