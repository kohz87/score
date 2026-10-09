import { copyFileSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { buildFixture } from '../hermes/sqlite-fixture.ts'

// A fake Hermes Kanban board built with SQL that mirrors the writers in hermes_cli/kanban_db.py (read as code only;
// no real board is ever opened). Each method names the Hermes function it mirrors.

export interface BoardSnapshot {
  events: unknown[]
  runs: unknown[]
  tasks: unknown[]
  eventSeq: number
  runSeq: number
}

export class FakeBoard {
  db: DatabaseSync
  /** Epoch seconds `now` for every writer. */
  clock = 1_800_000_000

  constructor(readonly path: string) {
    this.db = buildFixture(path, 'kanban')
  }

  tick(seconds = 1): number {
    this.clock += seconds
    return this.clock
  }

  /** kanban_db.create_task: row + `created` event. */
  task(id: string, options: { assignee?: string | null; status?: string; title?: string; startedAt?: number | null } = {}): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, body, assignee, status, created_by, created_at, started_at)
         VALUES (?, ?, NULL, ?, ?, 'lead', ?, ?)`,
      )
      .run(
        id,
        options.title ?? `Task ${id}`,
        options.assignee === undefined ? 'builder' : options.assignee,
        options.status ?? 'ready',
        this.clock,
        options.startedAt ?? null,
      )
    this.event(id, 'created', { by: 'lead' })
  }

  event(taskId: string, kind: string, payload: unknown = null, runId: number | null = null): number {
    return Number(
      this.db
        .prepare('INSERT INTO task_events (task_id, run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(taskId, runId, kind, payload ? JSON.stringify(payload) : null, this.clock).lastInsertRowid,
    )
  }

  /** `_claim_and_open_run`: CAS to running, run row with the claim lock, `claimed` event. */
  claim(taskId: string, options: { lock?: string; profile?: string | null; sourceStatus?: 'review' } = {}): number {
    const lock = options.lock ?? `host:${1000 + this.clock % 1000}`
    this.db
      .prepare("UPDATE tasks SET status = 'running', claim_lock = ?, started_at = COALESCE(started_at, ?) WHERE id = ?")
      .run(lock, this.clock, taskId)
    const profile =
      options.profile === undefined
        ? (this.db.prepare('SELECT assignee FROM tasks WHERE id = ?').get(taskId) as { assignee: string | null }).assignee
        : options.profile
    const runId = Number(
      this.db
        .prepare(
          `INSERT INTO task_runs (task_id, profile, status, claim_lock, claim_expires, started_at)
           VALUES (?, ?, 'running', ?, ?, ?)`,
        )
        .run(taskId, profile, lock, this.clock + 900, this.clock).lastInsertRowid,
    )
    this.db.prepare('UPDATE tasks SET current_run_id = ? WHERE id = ?').run(runId, taskId)
    this.event(
      taskId,
      'claimed',
      { lock, expires: this.clock + 900, run_id: runId, ...(options.sourceStatus ? { source_status: options.sourceStatus } : {}) },
      runId,
    )
    return runId
  }

  /** dispatcher spawn: PID + start fingerprint on the run, `spawned` event. */
  spawn(runId: number, pid: number, fingerprint: string | number = `boot|${pid}`): void {
    const run = this.db.prepare('SELECT task_id FROM task_runs WHERE id = ?').get(runId) as { task_id: string }
    this.db.prepare('UPDATE task_runs SET worker_pid = ?, worker_started_at = ? WHERE id = ?').run(pid, fingerprint, runId)
    this.event(run.task_id, 'spawned', { pid, started_at: fingerprint }, runId)
  }

  /** `_end_run`: closes the current run; claim_lock, pid and fingerprint stay on the closed row. */
  end(
    taskId: string,
    options: { outcome: string; status?: string; summary?: string | null; error?: string | null; event?: string | null },
  ): number | null {
    const row = this.db.prepare('SELECT current_run_id FROM tasks WHERE id = ?').get(taskId) as { current_run_id: number | null } | undefined
    const runId = row?.current_run_id ?? null
    if (runId === null) return null
    this.db
      .prepare(
        `UPDATE task_runs SET status = ?, outcome = ?, summary = ?, error = ?, ended_at = ?, claim_expires = NULL
          WHERE id = ? AND ended_at IS NULL`,
      )
      .run(options.status ?? options.outcome, options.outcome, options.summary ?? null, options.error ?? null, this.clock, runId)
    this.db.prepare('UPDATE tasks SET current_run_id = NULL WHERE id = ?').run(taskId)
    if (options.event !== null) this.event(taskId, options.event ?? options.outcome, null, runId)
    return runId
  }

  /** `_synthesize_ended_run`: zero-duration closed run for a transition on a never-claimed task. */
  synthesize(taskId: string, options: { outcome: string; event: string; profile?: string | null; summary?: string | null }): number {
    const assignee = (this.db.prepare('SELECT assignee FROM tasks WHERE id = ?').get(taskId) as { assignee: string | null }).assignee
    const runId = Number(
      this.db
        .prepare(
          `INSERT INTO task_runs (task_id, profile, status, outcome, summary, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(taskId, options.profile === undefined ? assignee : options.profile, options.outcome, options.outcome, options.summary ?? null, this.clock, this.clock)
        .lastInsertRowid,
    )
    this.event(taskId, options.event, null, runId)
    return runId
  }

  /** kanban_db_connect legacy backfill: a run for a task that is `running` with no current run. */
  legacyBackfill(taskId: string, options: { copyEvidence?: boolean } = {}): number {
    const task = this.db.prepare('SELECT assignee, claim_lock, started_at FROM tasks WHERE id = ?').get(taskId) as {
      assignee: string | null
      claim_lock: string | null
      started_at: number | null
    }
    const runId = Number(
      this.db
        .prepare(
          `INSERT INTO task_runs (task_id, profile, status, claim_lock, started_at)
           VALUES (?, ?, 'running', ?, ?)`,
        )
        .run(taskId, task.assignee, options.copyEvidence ? task.claim_lock : null, task.started_at ?? this.clock).lastInsertRowid,
    )
    this.db.prepare('UPDATE tasks SET current_run_id = ? WHERE id = ? AND current_run_id IS NULL').run(runId, taskId)
    return runId
  }

  /** A task left `running` by an older Hermes: status running, no run row, optionally a claim lock. */
  legacyRunningTask(id: string, options: { claimLock?: string | null; startedAt?: number } = {}): void {
    this.task(id, { status: 'running', startedAt: options.startedAt ?? this.clock })
    this.db.prepare('UPDATE tasks SET claim_lock = ? WHERE id = ?').run(options.claimLock ?? null, id)
  }

  /** `_reclaim_dangling_run`: close a leaked open run and clear its lock and pid. */
  reclaimDangling(runId: number): void {
    this.db
      .prepare(
        `UPDATE task_runs SET status = 'reclaimed', outcome = 'reclaimed', summary = COALESCE(summary, 'invariant recovery'),
           ended_at = ?, claim_lock = NULL, claim_expires = NULL, worker_pid = NULL WHERE id = ? AND ended_at IS NULL`,
      )
      .run(this.clock, runId)
  }

  /** invariant recovery clearing a lock, or the reaper clearing a pid, on a row. */
  clear(runId: number, columns: ('claim_lock' | 'worker_pid' | 'worker_started_at')[]): void {
    for (const column of columns) this.db.prepare(`UPDATE task_runs SET ${column} = NULL WHERE id = ?`).run(runId)
  }

  setRun(runId: number, values: Record<string, string | number | null>): void {
    const columns = Object.keys(values)
    this.db
      .prepare(`UPDATE task_runs SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`)
      .run(...columns.map((column) => values[column]!), runId)
  }

  /** Event GC (kanban_db.py:4379): old events of finished tasks go; runs stay. */
  gcEvents(beforeId: number): void {
    this.db.prepare('DELETE FROM task_events WHERE id < ?').run(beforeId)
  }

  /** Archive + delete: the task, its runs and its events disappear. */
  deleteTask(taskId: string): void {
    for (const table of ['task_events', 'task_runs'] as const)
      this.db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(taskId)
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
  }

  snapshot(): BoardSnapshot {
    const seq = (name: string) =>
      Number((this.db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(name) as { seq: number } | undefined)?.seq ?? 0)
    return {
      events: this.db.prepare('SELECT * FROM task_events ORDER BY id').all(),
      runs: this.db.prepare('SELECT * FROM task_runs ORDER BY id').all(),
      tasks: this.db.prepare('SELECT * FROM tasks').all(),
      eventSeq: seq('task_events'),
      runSeq: seq('task_runs'),
    }
  }

  /** An in-place restore of an earlier state: same file, same inode, rows and sequences as they were. */
  restore(snapshot: BoardSnapshot): void {
    this.db.exec('DELETE FROM task_events; DELETE FROM task_runs; DELETE FROM tasks;')
    for (const [table, rows] of [
      ['tasks', snapshot.tasks],
      ['task_runs', snapshot.runs],
      ['task_events', snapshot.events],
    ] as const) {
      for (const row of rows as Record<string, string | number | null>[]) {
        const columns = Object.keys(row)
        this.db
          .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
          .run(...columns.map((column) => row[column]!))
      }
    }
    this.setSequence('task_events', snapshot.eventSeq)
    this.setSequence('task_runs', snapshot.runSeq)
  }

  setSequence(name: string, seq: number | null): void {
    this.db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(name)
    if (seq !== null) this.db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, seq)
  }

  /** The same logical database copied onto a new inode (a backup restore to a new file). */
  copyToNewInode(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db.close()
    copyFileSync(this.path, `${this.path}.copy`)
    renameSync(`${this.path}.copy`, this.path)
    this.db = buildReopen(this.path)
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }
}

function buildReopen(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  return db
}
