import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { touch } from './ctx.ts'
import { AttemptRowSchema, type AttemptRow } from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'

export const stopMethods = {
  /** Delivers owed Stops until Hermes acknowledges. Abandoned attempts keep theirs. */
  async serviceStops(this: OrchestratorRuntime): Promise<boolean> {
    // Frozen: whose runs these handles name can't be told, so a Hermes Stop is not delivered (decision 71). A coding run
    // this process launched and is connected to is provably its own, and a Stop only ends work (decision 74): the coding
    // runtime answers those and refuses (`execution_frozen`) a recovered or inherited run, which then waits for the reset.
    const frozen = this.options.fence.executionFrozen() !== null
    const owedAll = this.db.read((sqlite) =>
      z
        .array(AttemptRowSchema)
        .parse(
          sqlite
            .prepare(
              `SELECT * FROM orc_attempts WHERE stop_requested_at IS NOT NULL AND stop_acknowledged_at IS NULL AND run_id IS NOT NULL AND state IN ('send_started', 'running', 'unknown', 'abandoned') AND unknown_reason IS NOT 'history_reset'`,
            )
            .all(),
        ),
    )
    const owed = frozen ? owedAll.filter((attempt) => attempt.runtime !== 'hermes') : owedAll
    for (const attempt of owed) {
      if (this.closed || this.stopJobs.has(attempt.id)) continue
      const last = this.stopTried.get(attempt.id)
      if (last !== undefined && this.nowMs() < last.at + last.delay) continue
      const job = this.deliverStop(attempt, frozen)
        .catch((error: unknown) => {
          this.err(error)
          return false
        })
        .then((acknowledged) => {
          this.stopJobs.delete(attempt.id)
          // An acknowledgement frees the attempt's slot, so the executor looks again; a retry wakes itself at its time.
          if (acknowledged) this.kick()
        })
      this.stopJobs.set(attempt.id, job)
    }
    // Nothing here is awaited: a slow or hung Stop never holds the pump (design §9). A finished job kicks it again.
    return false
  },

  /** One tracked Stop delivery for one attempt. Retries are paced by an exponential back-off per attempt. */
  async deliverStop(
    this: OrchestratorRuntime,
    attempt: AttemptRow,
    frozen: boolean,
  ): Promise<boolean> {
    const fails = this.stopTried.get(attempt.id)?.fails ?? 0
    const retry = () => {
      const delay = Math.min(this.retryMs * 2 ** fails, this.retryMs * 12)
      this.stopTried.set(attempt.id, { at: this.nowMs(), delay, fails: fails + 1 })
      this.wakeAfter(delay)
      return false
    }
    try {
      const outcome = await this.options.port.stopRun({
        agentId: attempt.agent_id,
        runId: attempt.run_id!,
      })
      // A coding Stop is acknowledged only by `stopped` or `not_running`; Hermes keeps `void` = acknowledged.
      const acknowledged =
        attempt.runtime === 'hermes'
          ? outcome !== 'unconfirmed'
          : outcome === 'stopped' || outcome === 'not_running'
      if (!acknowledged) return retry()
    } catch (error) {
      if (!(frozen && error instanceof HttpError && error.code === 'execution_frozen'))
        this.err(error)
      return retry()
    }
    // After the shutdown window the Stop stays durably owed; a late answer is not recorded into a closing database.
    if (this.abandonStops) return false
    this.stopTried.delete(attempt.id)
    await this.mutate((ctx) => {
      ctx.sqlite
        .prepare('UPDATE orc_attempts SET stop_acknowledged_at = ?, updated_at = ? WHERE id = ?')
        .run(ctx.now, ctx.now, attempt.id)
      touch(ctx, attempt.orchestration_id)
    })
    return true
  },
}

export type StopMethods = typeof stopMethods
