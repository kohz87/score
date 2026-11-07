import { type DatabaseSync } from 'node:sqlite'
import { redact } from '../../redact.ts'
import { touch } from './ctx.ts'
import { isFenced } from './fence.ts'
import { addStored } from './ops.ts'
import { adviseOnRepeatCheckFailure } from './advisor.ts'
import {
  CHECK_LEAD_BYTES,
  CHECK_OUTPUT_BYTES,
  CHECK_STORED_BYTES,
  type CheckConfig,
  checkConfigOf,
  checkIsCurrent,
  checkPending,
  checksOf,
  tailBytes,
} from './checks.ts'
import { addCause, addHistory, readOrch } from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'

export const checkMethods = {
  // --------------------------------------------------------------------------------------------------- checks (3.13)

  /**
   * Starts queued check runs (one at a time per job, only while it runs), stops the ones whose job no longer runs, and
   * cancels queued ones of jobs that ended. A run's end is recorded by itself (its own transaction) and wakes the lead.
   */
  async serviceChecks(this: OrchestratorRuntime): Promise<boolean> {
    for (const [id, job] of this.checkJobs) {
      const status = this.db.read((sqlite) => readOrch(sqlite, job.orchId)?.status)
      if (status === undefined || !['running', 'paused'].includes(status)) {
        job.proc.stop()
        this.checkJobs.delete(id)
      }
    }
    const starts = await this.mutate((ctx) => {
      const { sqlite, now } = ctx
      const rows = sqlite
        .prepare(
          `SELECT c.id, c.orchestration_id, o.status FROM orc_checks c JOIN orchestrations o ON o.id = c.orchestration_id
           WHERE c.outcome = 'queued' ORDER BY c.queued_at, c.rowid`,
        )
        .all() as { id: string; orchestration_id: string; status: string }[]
      const started: { id: string; orchId: string; config: CheckConfig }[] = []
      // A run marked running that nothing is carrying (its recording failed) would hold the job forever: end it.
      for (const stuck of sqlite
        .prepare("SELECT id, orchestration_id FROM orc_checks WHERE outcome = 'running'")
        .all() as { id: string; orchestration_id: string }[]) {
        if (this.checksInFlight.has(stuck.id)) continue
        sqlite
          .prepare("UPDATE orc_checks SET outcome = 'interrupted', ended_at = ? WHERE id = ?")
          .run(now, stuck.id)
        addCause(
          sqlite,
          stuck.orchestration_id,
          'check_interrupted',
          stuck.id,
          now,
          'its result was lost',
        )
        touch(ctx, stuck.orchestration_id)
      }
      for (const row of rows) {
        if (!['running', 'paused'].includes(row.status)) {
          sqlite
            .prepare("UPDATE orc_checks SET outcome = 'cancelled', ended_at = ? WHERE id = ?")
            .run(now, row.id)
          touch(ctx, row.orchestration_id)
          continue
        }
        // A paused job's checks wait; and one run at a time per job.
        if (row.status !== 'running' || isFenced(sqlite)) continue
        const busy = sqlite
          .prepare("SELECT 1 FROM orc_checks WHERE orchestration_id = ? AND outcome = 'running'")
          .get(row.orchestration_id)
        if (busy || started.some((s) => s.orchId === row.orchestration_id)) continue
        const config = checkConfigOf(sqlite, row.orchestration_id)
        if (config === null) {
          sqlite
            .prepare("UPDATE orc_checks SET outcome = 'cancelled', ended_at = ? WHERE id = ?")
            .run(now, row.id)
          continue
        }
        sqlite
          .prepare("UPDATE orc_checks SET outcome = 'running', started_at = ? WHERE id = ?")
          .run(now, row.id)
        addHistory(sqlite, row.orchestration_id, 'check_started', { checkId: row.id }, now)
        touch(ctx, row.orchestration_id)
        started.push({ id: row.id, orchId: row.orchestration_id, config })
        this.checksInFlight.add(row.id)
      }
      return started
    })
    for (const start of starts) void this.runCheckProcess(start)
    return false
  },

  async runCheckProcess(
    this: OrchestratorRuntime,
    start: {
      id: string
      orchId: string
      config: CheckConfig
    },
  ): Promise<void> {
    const record = async (
      outcome: 'passed' | 'failed' | 'timed_out' | 'refused' | 'cancelled',
      exitCode: number | null,
      output: string,
    ) => {
      // Redacted before it is cut, so a secret straddling the cut is still recognised (review P3).
      const kept = tailBytes(redact(output), CHECK_STORED_BYTES)
      await this.mutate((ctx) => {
        const { sqlite, now } = ctx
        const row = sqlite.prepare('SELECT outcome FROM orc_checks WHERE id = ?').get(start.id) as
          { outcome: string } | undefined
        if (row?.outcome !== 'running') return
        sqlite
          .prepare(
            'UPDATE orc_checks SET outcome = ?, exit_code = ?, ended_at = ?, output = ? WHERE id = ?',
          )
          .run(outcome, exitCode, now, kept, start.id)
        addStored(sqlite, start.orchId, Buffer.byteLength(kept))
        addHistory(
          sqlite,
          start.orchId,
          'check_ended',
          { checkId: start.id, outcome, exitCode },
          now,
        )
        // Only Score's own words here: the command's output reaches the lead quoted, never as an unquoted cause line.
        const detail =
          outcome === 'passed'
            ? 'exit 0'
            : outcome === 'timed_out'
              ? 'timed out'
              : outcome === 'refused'
                ? 'could not run'
                : outcome === 'cancelled'
                  ? 'stopped'
                  : `exit ${exitCode ?? '?'}`
        addCause(
          sqlite,
          start.orchId,
          outcome === 'passed' ? 'check_passed' : 'check_failed',
          start.id,
          now,
          detail,
        )
        // 3.14: the same check failure twice in a row goes to the advisor.
        const o = readOrch(sqlite, start.orchId)
        if (o && outcome !== 'passed') adviseOnRepeatCheckFailure(ctx, o)
        touch(ctx, start.orchId)
      })
      this.kick()
    }
    try {
      if (!this.options.checks) return await record('refused', null, 'Checks can’t run here.')
      const proc = await this.options.checks({
        argv: start.config.argv,
        cwd: start.config.workspace,
        timeoutMs: start.config.timeoutSec * 1000,
        keepBytes: CHECK_OUTPUT_BYTES,
      })
      if ('refused' in proc) return await record('refused', null, proc.refused)
      this.checkJobs.set(start.id, { orchId: start.orchId, proc })
      const result = await proc.done
      this.checkJobs.delete(start.id)
      if (this.closed) return // recorded as interrupted at the next start
      await record(
        result.timedOut
          ? 'timed_out'
          : result.stopped
            ? 'cancelled'
            : result.exitCode === 0
              ? 'passed'
              : 'failed',
        result.exitCode,
        result.output,
      )
    } catch (error) {
      this.err(error)
      this.checkJobs.delete(start.id)
    } finally {
      // Not recorded by now (a failed write): the next pass ends it as interrupted rather than leaving it running.
      this.checksInFlight.delete(start.id)
      this.kick()
    }
  },

  /** What the lead reads about the check: the command, and the last run's verdict and output tail. */
  leadCheck(this: OrchestratorRuntime, sqlite: DatabaseSync, orchId: string) {
    const config = checkConfigOf(sqlite, orchId)
    if (config === null) return null
    const latest = checksOf(sqlite, orchId, 5).find(
      (row) => !['queued', 'cancelled'].includes(row.outcome),
    )
    return {
      argv: config.argv,
      workspace: config.workspace,
      when: config.when,
      waived:
        (
          sqlite.prepare('SELECT check_waived_at FROM orchestrations WHERE id = ?').get(orchId) as {
            check_waived_at: string | null
          }
        ).check_waived_at !== null,
      pending: checkPending(sqlite, orchId),
      latest: latest
        ? {
            outcome: latest.outcome,
            exitCode: latest.exit_code,
            current: latest.outcome === 'passed' && checkIsCurrent(sqlite, orchId, latest),
            output: tailBytes(latest.output, CHECK_LEAD_BYTES),
          }
        : null,
    }
  },
}

export type CheckMethods = typeof checkMethods
