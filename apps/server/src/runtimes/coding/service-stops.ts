import type { StopOutcome } from '../../hermes/index.ts'
import { HttpError } from '../../errors.ts'
import { CodingRuntimeAdmission } from './service-admission.ts'
import { stopCauseOf, type StopReason } from './process.ts'
import type { ActiveRun } from './service-types.ts'
import { getCodingAgent } from './store.ts'
import { newTranslation } from './translate.ts'

export class CodingRuntimeStops extends CodingRuntimeAdmission {
  /**
   * Stop says what really happened. A run this process holds gets the request (its end arrives through the normal
   * terminal path). Otherwise durable state decides: a run still queued never launched, so it is cancelled; a recorded
   * process group is stopped and, if that can't be proven in a moment, the answer is `unconfirmed` while the kill goes
   * on in the background; no record and an ended run means there is nothing to stop.
   */
  async stopRun(req: { agentId: string; runId: string }): Promise<StopOutcome> {
    const entry = this.active.get(req.runId)
    // A Stop is an outgoing control call (decisions 71 and 72). While Score holds all agent work it still stops a run this
    // process started itself (decision 74): that run is provably its own and a Stop only ends work. Recovered or
    // inherited runs wait for reset-history.
    const hold = this.deps.frozen?.() ?? null
    if (hold !== null && !entry)
      throw new HttpError(423, 'execution_frozen', hold, { notice: hold })
    if (entry) {
      if (entry.agentId !== req.agentId) return 'not_running'
      this.requestStop(entry, 'user')
      // Nothing was ever started (still queued behind another turn, or stopped before launch): there is nothing to
      // prove, and nothing will launch.
      if (!entry.launched) return 'stopped'
      // `stopped` is a proof: the group is gone (X4). The stop goes on in the background if it takes longer.
      return Promise.race([
        entry.ended.then((gone) => (gone ? ('stopped' as const) : ('unconfirmed' as const))),
        new Promise<'unconfirmed'>((resolve) =>
          setTimeout(resolve, this.deps.stopObserveMs ?? 1000, 'unconfirmed').unref(),
        ),
      ])
    }
    const { sqlite } = this.deps.db
    const run = sqlite
      .prepare('SELECT status, profile FROM runs WHERE id = ? AND runtime != ?')
      .get(req.runId, 'hermes') as { status: string; profile: string } | undefined
    // A restored database may have lost the run row while the journal still holds its launch (7.7b §2, K4): the launch
    // evidence is resolved before answering, so a missing row never means "not running".
    const known = this.deps.unit?.openLaunchesOf(req.runId, req.agentId) ?? []
    if (run ? run.profile !== req.agentId : known.length === 0) return 'not_running'
    const record = this.recordOf(req.runId)
    if (record) {
      this.recordStop('user')
      const reaping = this.reapInBackground(req.runId)
      const answer = await Promise.race([
        reaping.then((gone) => (gone ? ('stopped' as const) : ('unconfirmed' as const))),
        new Promise<'unconfirmed'>((resolve) =>
          setTimeout(resolve, this.deps.stopObserveMs ?? 1000, 'unconfirmed').unref(),
        ),
      ])
      return answer
    }
    const launches = known
    if (launches.length > 0) {
      const unit = this.deps.unit!
      const gone = Promise.all(launches.map((id) => unit.stopUnattached(id))).then((all) =>
        all.every(Boolean),
      )
      const answer = await Promise.race([
        gone.then((ok) => (ok ? ('stopped' as const) : ('unconfirmed' as const))),
        new Promise<'unconfirmed'>((resolve) =>
          setTimeout(resolve, this.deps.stopObserveMs ?? 1000, 'unconfirmed').unref(),
        ),
      ])
      if (answer === 'stopped') await this.cancelIfOpen(req.agentId, req.runId)
      // The stop goes on in the background; once the unit is proven ended the run ends as cancelled.
      else
        for (const id of launches)
          void unit
            .reap(id, this.deps.reapRetryMs)
            .then((ok) => (ok ? this.cancelIfOpen(req.agentId, req.runId) : undefined))
            .catch((error: unknown) => this.deps.onError?.(error))
      return answer
    }
    if (!run) return 'unconfirmed'
    if (run.status === 'queued') {
      // Queued means the run never left the queue: the process cannot exist.
      const agent = getCodingAgent(this.deps.db.sqlite, req.agentId, true)
      await this.finish(newTranslation(req.runId, req.agentId, this.jobOfRun(req.runId)), {
        status: 'cancelled',
        costKind: agent?.runtime === 'claude-code' ? 'estimated' : 'unknown',
      })
      return 'stopped'
    }
    if (run.status === 'running' || run.status === 'waiting_for_approval') return 'unconfirmed'
    return 'not_running'
  }

  /** A run whose supervised unit is proven ended by a Stop that found no live handle: it ends as cancelled. */
  protected async cancelIfOpen(agentId: string, runId: string): Promise<void> {
    const run = this.deps.db.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as
      { status: string } | undefined
    if (!run || !['queued', 'running', 'waiting_for_approval'].includes(run.status)) return
    const agent = getCodingAgent(this.deps.db.sqlite, agentId, true)
    await this.finish(newTranslation(runId, agentId, this.jobOfRun(runId)), {
      status: 'cancelled',
      costKind: agent?.runtime === 'claude-code' ? 'estimated' : 'unknown',
      group: 'released',
    })
  }

  protected jobOfRun(runId: string): string | null {
    const row = this.deps.db.sqlite
      .prepare('SELECT job_id FROM message_runs WHERE run_id = ?')
      .get(runId) as { job_id: string } | undefined
    return row?.job_id ?? null
  }

  protected requestStop(entry: ActiveRun, reason: StopReason): void {
    if (entry.process) entry.process.stop(reason)
    else entry.stopBeforeStart ??= reason
  }

  /** A stop asked outside any live process (a recorded group): its cause goes to the hook like any other. */
  protected recordStop(reason: StopReason): void {
    try {
      this.deps.onStop?.(stopCauseOf(reason))
    } catch (error) {
      this.deps.onError?.(error)
    }
  }
}
