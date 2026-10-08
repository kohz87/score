import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { taskStatus } from '../domain/briefs.ts'

const PAUSE_REASON = 'Paused from Score'
const RESUME_REASON = 'Resumed from Score'
/** Statuses Score parks. Triage is not dispatchable, and anything else has started or moved on. */
const PARKABLE = ['ready', 'todo']

export type HoldOwner = { kind: 'brief' | 'agent'; id: string }

const TABLES = {
  brief: { table: 'brief_paused_tasks', column: 'brief_id' },
  agent: { table: 'agent_paused_tasks', column: 'agent_id' },
} as const

const StateRow = z.object({ state: z.enum(['pending', 'held']) })
const TaskRow = z.object({ task_id: z.string() })
const OwnerRow = z.object({ owner: z.string() })

/** Whether any hold (any owner, any state) other than `except` still wants the task parked. */
function otherHold(sqlite: DatabaseSync, taskId: string, except: HoldOwner): boolean {
  return (['brief', 'agent'] as const).some((kind) => {
    const { table, column } = TABLES[kind]
    const exclude = kind === except.kind ? `AND ${column} <> ?` : ''
    return (
      sqlite
        .prepare(`SELECT 1 FROM ${table} WHERE task_id = ? ${exclude}`)
        .get(...(kind === except.kind ? [taskId, except.id] : [taskId])) !== undefined
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
  for (const taskId of taskIds)
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO ${table} (${column}, task_id, blocked_at, state) VALUES (?, ?, ?, 'pending')`,
      )
      .run(owner.id, taskId, now)
}

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
}): TaskHolds {
  const { port, db, ingest } = deps
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
          .prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? AND task_id = ? AND legacy = 1`)
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

  const taskIdsOf = (owner: HoldOwner, pendingOnly: boolean) =>
    db.read((sqlite) => {
      const { table, column } = TABLES[owner.kind]
      return z
        .array(TaskRow)
        .parse(
          sqlite
            .prepare(
              `SELECT task_id FROM ${table} WHERE ${column} = ? ${pendingOnly ? "AND state = 'pending'" : ''} ORDER BY rowid`,
            )
            .all(owner.id),
        )
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

  const holds: TaskHolds = {
    apply: (owner, stillPaused) =>
      each(taskIdsOf(owner, true), (taskId) => applyOne(owner, taskId, stillPaused)),
    release: (owner) =>
      each(taskIdsOf(owner, false), async (taskId) => {
        await releaseOne(owner, taskId)
        return true
      }),
    async recover(isPaused) {
      const owners = db.read((sqlite) =>
        (['brief', 'agent'] as const).flatMap((kind) => {
          const { table, column } = TABLES[kind]
          return z
            .array(OwnerRow)
            .parse(sqlite.prepare(`SELECT DISTINCT ${column} AS owner FROM ${table}`).all())
            .map((row): HoldOwner => ({ kind, id: row.owner }))
        }),
      )
      let unresolved = 0
      for (const owner of owners) {
        const failed = await (isPaused(owner)
          ? holds.apply(owner, () => isPaused(owner))
          : holds.release(owner))
        unresolved += failed.length
      }
      return unresolved
    },
  }
  return holds
}
