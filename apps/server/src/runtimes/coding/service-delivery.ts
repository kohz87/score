import { z } from 'zod'
import { CodingRuntimeWorkers } from './service-workers.ts'
import { redactedInfo, TERMINAL_NOTE } from './service-types.ts'
import {
  newTranslation,
  pendingBytes,
  terminalObservation,
  type RunTranslation,
  type TerminalInfo,
} from './translate.ts'

export class CodingRuntimeDelivery extends CodingRuntimeWorkers {
  /**
   * Saves the terminal result. The outcome is first kept in a durable pending record, then saved with a bounded
   * backoff without touching the process. If that budget runs out the result is NOT dropped: it is retried in the
   * background (up to a minute apart) until it commits, the failure is reported once, and the active entry and the
   * process record stay meanwhile. The record is also committed on restart. The CLI is never launched again (S3-004).
   */
  protected async finish(translation: RunTranslation, info: TerminalInfo): Promise<unknown> {
    this.keepPending(translation, info)
    // Until it is saved the result and the translator's state are still in memory: they stay charged (FW #8).
    this.deps.unit?.holdDelivery(translation.runId, pendingBytes(translation, info))
    const tries = 5
    let delay = this.deps.terminalRetryMs ?? 250
    let last: unknown
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const result = await this.commitTerminal(translation, info)
        return result
      } catch (error) {
        last = error
        if (attempt < tries - 1) {
          await new Promise((r) => setTimeout(r, delay))
          delay *= 2
        }
      }
    }
    this.deps.onError?.(last)
    if (!this.deliveries.has(translation.runId) && !this.closed) {
      const loop = this.deliverInBackground(translation, info)
        .catch((error: unknown) => this.deps.onError?.(error))
        .finally(() => this.deliveries.delete(translation.runId))
      this.deliveries.set(translation.runId, loop)
    }
    return undefined
  }

  protected async commitTerminal(
    translation: RunTranslation,
    info: TerminalInfo,
  ): Promise<unknown> {
    const result = await this.deps.ingest.submit(terminalObservation(translation, info))
    this.dropPending(translation.runId)
    // The terminal result is saved: the unit launch is settled and collected (design §6b). A failure here never
    // un-saves the result; recovery settles whatever was left.
    await this.deps.unit
      ?.settleRun(translation.runId)
      .catch((error: unknown) => this.deps.onError?.(error))
    return result
  }

  protected async deliverInBackground(
    translation: RunTranslation,
    info: TerminalInfo,
  ): Promise<void> {
    let delay = this.deps.terminalRetryMs ?? 250
    for (;;) {
      await this.wait(Math.min(delay, 60_000))
      delay = Math.min(delay * 2, 60_000)
      // On shutdown the durable record is left for the next start.
      if (this.closed) return
      try {
        await this.commitTerminal(translation, info)
        return
      } catch {
        // keep trying; the first failure was reported
      }
    }
  }

  protected keepPending(translation: RunTranslation, info: TerminalInfo): void {
    try {
      this.deps.db.sqlite
        .prepare(
          `INSERT OR IGNORE INTO coding_pending_terminals (run_id, agent_id, job_id, usage, info, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          translation.runId,
          translation.agentId,
          translation.jobId,
          translation.usage ? JSON.stringify(translation.usage) : null,
          // Free text is redacted and bounded BEFORE it reaches the disk: deleting the row later would not remove the
          // bytes already written to the WAL or the database file (review 2026-10-12 #7). Same limits as the terminal row.
          JSON.stringify(redactedInfo(info)),
          new Date().toISOString(),
        )
    } catch (error) {
      // The in-memory retry still runs; only a restart before it succeeds would lose the exact result.
      this.deps.onError?.(error)
    }
  }

  protected dropPending(runId: string): void {
    this.deps.unit?.releaseDelivery(runId)
    try {
      this.deps.db.sqlite
        .prepare('DELETE FROM coding_pending_terminals WHERE run_id = ?')
        .run(runId)
    } catch (error) {
      this.deps.onError?.(error)
    }
  }

  /**
   * A pending SUCCESS never survives a restart (design v7 §4, review 2026-10-12 #13): the group's end was not proven
   * across the incarnation, so the candidate is not promoted to a result and no hand-off follows from it. Failures,
   * cancellations and interruptions keep their meaning; the process records are left for the recovery below to settle.
   */
  protected afterRestart(info: TerminalInfo): TerminalInfo {
    if (info.status !== 'completed') return info
    return {
      status: 'interrupted',
      output: info.output ?? null,
      error: TERMINAL_NOTE.interrupted,
      costKind: info.costKind,
      reply: null,
    }
  }

  /** Terminal results that were still waiting to be saved when Score stopped: committed before recovery interrupts anything. */
  protected async commitPendingTerminals(): Promise<void> {
    const rows = z
      .array(
        z.object({
          run_id: z.string(),
          agent_id: z.string(),
          job_id: z.string().nullable(),
          usage: z.string().nullable(),
          info: z.string(),
        }),
      )
      .parse(
        this.deps.db.sqlite
          .prepare('SELECT * FROM coding_pending_terminals ORDER BY created_at')
          .all(),
      )
    for (const row of rows) {
      try {
        const translation = newTranslation(row.run_id, row.agent_id, row.job_id)
        if (row.usage)
          translation.usage = JSON.parse(row.usage) as NonNullable<RunTranslation['usage']>
        await this.commitTerminal(
          translation,
          this.afterRestart(JSON.parse(row.info) as TerminalInfo),
        )
      } catch (error) {
        // Stays recorded; the interruption below still ends the run if it is not terminal by then.
        this.deps.onError?.(error)
      }
    }
  }
}
