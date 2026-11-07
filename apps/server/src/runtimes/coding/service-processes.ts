import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import {
  bootId,
  killRecordedGroup,
  processStart,
  type GroupOutcome,
  type MemberIdentity,
} from './proc.ts'
import { CodingRuntimeCli } from './service-cli.ts'
import { MemberRow, ProcessRow } from './service-types.ts'

export class CodingRuntimeProcesses extends CodingRuntimeCli {
  /**
   * On start (review 2026-10-09, 7.2 #3): a CLI child dies with Score, so a turn still marked running or queued is
   * interrupted with a note. The CLI session id stays, so the next message resumes it.
   */
  /**
   * Durable before anything reads the child's output: the detached child is its own group leader (pgid = pid). A plain
   * insert: a record that is still there belongs to a group nobody proved gone, and is never overwritten (the throw
   * makes the new group be killed).
   */
  protected recordProcess(runId: string, pid: number): void {
    this.deps.db.sqlite
      .prepare(
        `INSERT INTO coding_processes (run_id, pid, pgid, start_time, boot_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, pid, pid, processStart(pid), bootId(), new Date().toISOString())
  }
  protected forgetProcess(runId: string): void {
    const { sqlite } = this.deps.db
    sqlite.prepare('DELETE FROM coding_processes WHERE run_id = ?').run(runId)
    sqlite.prepare('DELETE FROM coding_process_members WHERE run_id = ?').run(runId)
  }

  /** Identities of the group's members, recorded while Score supervises it (N4). */
  protected recordMembers(runId: string, members: MemberIdentity[]): void {
    const boot = bootId()
    const now = new Date().toISOString()
    const insert = this.deps.db.sqlite.prepare(
      'INSERT OR IGNORE INTO coding_process_members (run_id, pid, start_time, boot_id, seen_at) VALUES (?, ?, ?, ?, ?)',
    )
    const { sqlite } = this.deps.db
    sqlite.exec('BEGIN')
    try {
      for (const member of members) insert.run(runId, member.pid, member.startTime, boot, now)
      sqlite.exec('COMMIT')
    } catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }
  }
  protected membersOf(runId: string): MemberIdentity[] {
    return this.deps.db.sqlite
      .prepare('SELECT pid, start_time FROM coding_process_members WHERE run_id = ?')
      .all(runId)
      .map((row) => MemberRow.parse(row))
      .map((row) => ({ pid: row.pid, startTime: row.start_time }))
  }

  protected recordOf(runId: string) {
    const row = this.deps.db.sqlite
      .prepare('SELECT * FROM coding_processes WHERE run_id = ?')
      .get(runId)
    return row === undefined ? null : ProcessRow.parse(row)
  }

  /** A process group of this agent that was never proven gone: the agent takes no new turn until it is. */
  protected hasUnresolvedGroup(agentId: string): boolean {
    if ((this.deps.unit?.held(agentId).length ?? 0) > 0) return true
    // A recorded group whose run row is gone (a restored older database) has no agent to blame: it fences everyone.
    return (
      this.deps.db.sqlite
        .prepare(
          `SELECT 1 FROM coding_processes cp LEFT JOIN runs r ON r.id = cp.run_id
           WHERE cp.unresolved = 1 AND (r.id IS NULL OR r.profile = ?)`,
        )
        .get(agentId) !== undefined
    )
  }

  /** A wait that close() ends early. */
  protected wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.wakers.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      timer.unref()
      this.wakers.add(wake)
    })
  }

  /**
   * Stops a recorded group until it is proven gone, then drops the record. Retries with a bounded backoff (the
   * answer for a caller is the first attempt's); one loop per run. Resolves true once the record is gone.
   */
  protected reapInBackground(runId: string, extraMembers: MemberIdentity[] = []): Promise<boolean> {
    const known = this.reapers.get(runId)
    if (known) return known
    const loop = (async () => {
      let delay = this.deps.reapRetryMs ?? 2000
      for (let first = true; ; first = false) {
        if (!first) {
          await this.wait(delay)
          delay = Math.min(delay * 2, 60_000)
        }
        const record = this.recordOf(runId)
        if (!record) return true
        if (!this.ownsRow(runId)) return false
        const outcome = await this.stopGroup(record, extraMembers)
        if (outcome === 'gone') {
          this.forgetProcess(runId)
          return true
        }
        this.markUnobservable(runId, outcome === 'unobservable')
        if (this.closed) return false
      }
    })()
      .catch((error: unknown) => {
        this.deps.onError?.(error)
        return false
      })
      .finally(() => this.reapers.delete(runId))
    this.reapers.set(runId, loop)
    return loop
  }

  /** A throwing check counts as not ours: nothing is signalled on doubt. */
  protected ownsRow(runId: string): boolean {
    try {
      // Frozen: whose process this is can't be told, so nothing is signalled (decision 71).
      if (this.deps.frozen?.() != null) return false
      return this.deps.ownsProcessRow?.(runId) ?? true
    } catch (error) {
      this.deps.onError?.(error)
      return false
    }
  }

  protected markUnobservable(runId: string, value: boolean): void {
    this.deps.db.sqlite
      .prepare('UPDATE coding_processes SET unobservable = ? WHERE run_id = ?')
      .run(value ? 1 : 0, runId)
  }

  protected stopGroup(
    record: z.infer<typeof ProcessRow>,
    extraMembers: MemberIdentity[] = [],
  ): Promise<GroupOutcome> {
    // A group recorded without any process identity can't be signalled: it stays unobservable (and releasable).
    if (record.pid <= 1 && extraMembers.length === 0) return Promise.resolve('unobservable')
    const members = new Map<number, MemberIdentity>()
    for (const member of [...this.membersOf(record.run_id), ...extraMembers])
      members.set(member.pid, member)
    return (this.deps.killGroup ?? killRecordedGroup)({
      pid: record.pid,
      pgid: record.pgid,
      startTime: record.start_time,
      bootId: record.boot_id,
      members: [...members.values()],
      onMembers: (members) => this.recordMembers(record.run_id, members),
    })
  }

  /** Groups of this agent that were not proven gone; `canRelease` = Score can't tell whether they are its own. */
  heldGroups(
    agentId: string,
  ): { runId: string; pgid: number; canRelease: boolean; unit?: string }[] {
    const units = (this.deps.unit?.held(agentId) ?? []).map((held) => ({
      runId: held.runId,
      pgid: 0,
      canRelease: held.canRelease,
      unit: held.unit,
    }))
    return [...this.processGroups(agentId), ...units]
  }

  protected processGroups(agentId: string): { runId: string; pgid: number; canRelease: boolean }[] {
    return this.deps.db.sqlite
      .prepare(
        `SELECT cp.run_id, cp.pgid, cp.unobservable FROM coding_processes cp LEFT JOIN runs r ON r.id = cp.run_id
         WHERE (r.id IS NULL OR r.profile = ?) AND cp.unresolved = 1 ORDER BY cp.created_at`,
      )
      .all(agentId)
      .map((row) =>
        z.object({ run_id: z.string(), pgid: z.int(), unobservable: z.int() }).parse(row),
      )
      .map((row) => ({ runId: row.run_id, pgid: row.pgid, canRelease: row.unobservable === 1 }))
  }

  /**
   * The person's deliberate way out of a group Score can't attribute: the records go, the agent may take turns again,
   * and an audit row names who and when. Nothing is ever signalled. Returns how many groups were released.
   */
  release(agentId: string, by: string): number {
    const { db } = this.deps
    const candidates = db.sqlite
      .prepare(
        `SELECT cp.run_id, cp.pid, cp.pgid FROM coding_processes cp LEFT JOIN runs r ON r.id = cp.run_id
         WHERE (r.id IS NULL OR r.profile = ?) AND cp.unresolved = 1 AND cp.unobservable = 1`,
      )
      .all(agentId)
      .map((row) => z.object({ run_id: z.string(), pid: z.int(), pgid: z.int() }).parse(row))
    const rows = candidates
    const units = this.deps.unit?.held(agentId).filter((held) => held.canRelease) ?? []
    if (rows.length === 0 && units.length === 0)
      throw new HttpError(
        409,
        'conflict',
        'Nothing to release: Score has no unclear processes for this agent.',
      )
    const at = new Date().toISOString()
    const releasedUnits = units.length > 0 ? (this.deps.unit?.releaseHeld(agentId, by) ?? []) : []
    for (const released of releasedUnits)
      db.sqlite
        .prepare(
          'INSERT INTO coding_releases (agent_id, run_id, pid, pgid, released_by, released_at) VALUES (?, ?, 0, 0, ?, ?)',
        )
        .run(agentId, released.runId, by, at)
    db.tx((sqlite) => {
      for (const row of rows) {
        sqlite
          .prepare(
            'INSERT INTO coding_releases (agent_id, run_id, pid, pgid, released_by, released_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(agentId, row.run_id, row.pid, row.pgid, by, at)
        sqlite.prepare('DELETE FROM coding_processes WHERE run_id = ?').run(row.run_id)
        sqlite.prepare('DELETE FROM coding_process_members WHERE run_id = ?').run(row.run_id)
      }
    })
    return rows.length + releasedUnits.length
  }
}
