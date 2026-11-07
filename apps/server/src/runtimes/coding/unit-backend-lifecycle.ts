import { codingProjection } from '../../domain/orchestration/coding-checkpoint.ts'
import { UnitBackendLaunch } from './unit-backend-launch.ts'
import { sleep, type Row } from './unit-backend-helpers.ts'
import type { StopReason } from './process.ts'
import { resetUnit } from './units.ts'

export class UnitBackendLifecycle extends UnitBackendLaunch {
  // ---- settlement and collection (§6b) ------------------------------------------------------------------------------

  /**
   * After the run's terminal result committed: `settled`, then collection (`reset-failed` through the exact-name,
   * InvocationID-gated path). Only a launch whose end is proven and whose run is terminal is touched. Returns the
   * number of launches settled.
   */
  async settleRun(runId: string, disposition = 'committed'): Promise<number> {
    const run = this.deps.db.sqlite.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as
      { status: string } | undefined
    if (!run || ['queued', 'running', 'waiting_for_approval'].includes(run.status)) return 0
    const rows = this.deps.db.sqlite
      .prepare(
        "SELECT * FROM coding_launches WHERE run_id = ? AND backend = 'unit' AND phase = 'ended'",
      )
      .all(runId) as unknown as Row[]
    let settled = 0
    for (const row of rows) {
      if (await this.settle(row, disposition)) settled++
    }
    return settled
  }

  /** A launch of a turn that went on to a second launch (a refused resume): settled as retried. */
  async settleLaunch(launchId: string, disposition: string): Promise<boolean> {
    const row = this.rowOf(launchId)
    return row && row.phase === 'ended' ? this.settle(row, disposition) : false
  }

  protected async settle(row: Row, disposition: string): Promise<boolean> {
    // A launch that isn't this installation's (a copied witness) is evidence only: never settled, never reset.
    if (!this.owns(row.launch_id, row.unit)) return false
    const result = this.deps.journal.settled(
      row.launch_id,
      { disposition },
      codingProjection(this.deps.db, this.clock),
    )
    if (!result.ok) {
      this.deps.onError?.(new Error(`settle refused: ${result.reason}`))
      return false
    }
    const rec = this.recorded(row.launch_id)
    if (rec.unit && rec.invocationId && this.owns(row.launch_id, rec.unit)) {
      try {
        await resetUnit(this.run, rec.unit, rec.invocationId, this.prefix)
      } catch (error) {
        this.deps.onError?.(error)
      }
    }
    return true
  }

  // ---- unresolved launches ---------------------------------------------------------------------------------------

  /** Launches of an agent whose end was never proven: the agent takes no new turn while any is held. */
  held(agentId: string): { runId: string; launchId: string; unit: string; canRelease: boolean }[] {
    return (
      this.deps.db.sqlite
        .prepare(
          "SELECT run_id, launch_id, unit, held FROM coding_launches WHERE agent_id = ? AND backend = 'unit' AND held > 0 AND phase NOT IN ('ended','settled') ORDER BY updated_at",
        )
        .all(agentId) as { run_id: string; launch_id: string; unit: string; held: number }[]
    ).map((r) => ({
      runId: r.run_id,
      launchId: r.launch_id,
      unit: r.unit,
      canRelease: r.held === 2,
    }))
  }

  /**
   * The person's deliberate way out of a launch Score can’t observe: recorded as a waiver, nothing is signalled. The
   * waiver goes into the journal first and settles the launch there, so a restart never stops it again; only then do the
   * database projections change (review 2026-10-12 #8). A launch whose waiver can't be journaled stays held.
   */
  releaseHeld(
    agentId: string,
    by = 'the person',
  ): { launchId: string; runId: string; unit: string }[] {
    const rows = this.deps.db.sqlite
      .prepare(
        "SELECT * FROM coding_launches WHERE agent_id = ? AND backend = 'unit' AND held = 2 AND phase NOT IN ('ended','settled')",
      )
      .all(agentId) as unknown as Row[]
    const released: Row[] = []
    for (const row of rows) {
      if (!this.owns(row.launch_id, row.unit)) continue
      const waived = this.deps.journal.waive(
        row.launch_id,
        by,
        codingProjection(this.deps.db, this.clock, (sqlite) =>
          sqlite
            .prepare(
              "UPDATE coding_launches SET held = 0, waiver = 1, disposition = 'waived' WHERE launch_id = ?",
            )
            .run(row.launch_id),
        ),
      )
      if (!waived.ok) {
        this.deps.onError?.(new Error(`waiver not journaled: ${waived.reason}`))
        continue
      }
      // `waive` projected the settled launch; `held` is runtime state the projection doesn't own, so clear it here too.
      this.deps.db.sqlite
        .prepare(
          "UPDATE coding_launches SET held = 0, waiver = 1, disposition = 'waived', phase = 'settled' WHERE launch_id = ?",
        )
        .run(row.launch_id)
      released.push(row)
    }
    return released.map((r) => ({ launchId: r.launch_id, runId: r.run_id, unit: r.unit ?? '' }))
  }

  /**
   * Stops an unresolved launch until it is proven ended (bounded backoff, one loop per launch). Resolves true once
   * proven. A launch whose unit can’t be read stays held and becomes releasable by the person.
   */
  reap(launchId: string, retryMs = 2000): Promise<boolean> {
    const known = this.reapers.get(launchId)
    if (known) return known
    const loop = (async () => {
      let delay = retryMs
      for (let first = true; !this.closed; first = false) {
        if (!first) {
          await sleep(delay)
          delay = Math.min(delay * 2, 60_000)
        }
        const row = this.rowOf(launchId)
        if (!row) return true
        if (row.phase === 'ended' || row.phase === 'settled') return true
        const stop = await this.stopSupervisor(launchId)
        const proof = await this.proveEnded(launchId, { timeoutMs: 5000 })
        if (proof.proven) {
          this.endRecord(row, proof.proof ?? 'unknown')
          this.markHeld(launchId, 0)
          await this.settleRun(row.run_id, 'interrupted')
          return true
        }
        this.markHeld(
          launchId,
          stop === 'unknown' || /can’t be read|differs|disagrees/.test(proof.detail) ? 2 : 1,
        )
      }
      return false
    })()
      .catch((error: unknown) => {
        this.deps.onError?.(error)
        return false
      })
      .finally(() => this.reapers.delete(launchId))
    this.reapers.set(launchId, loop)
    return loop
  }

  protected endRecord(row: Row, proof: string): void {
    this.adoptStopReceipt(row.launch_id)
    const project = codingProjection(this.deps.db, this.clock)
    const state = this.deps.journal.state(row.launch_id)
    if (
      state?.kind === 'releasing' &&
      row.receipt_dir &&
      this.readReceipt(row, 'released.json') === 'present'
    )
      this.deps.journal.releasedSeen(row.launch_id, {}, project)
    // A launch that never executed is revoked before it ends: the journal alone proves no-launch (§3).
    if (state && !state.state.mayHaveExecuted && !state.state.revoked) {
      const cause = state.state.stopCause
      this.deps.journal.revoke(
        row.launch_id,
        undefined,
        project,
        cause === undefined
          ? 'start_failed'
          : cause === 'deadline'
            ? 'deadline'
            : cause === 'score-shutdown' || cause === 'unit-stop'
              ? 'restart'
              : 'stop',
      )
    }
    const ended = this.deps.journal.ended(row.launch_id, { proof }, project)
    if (!ended.ok && ended.reason !== 'illegal_transition')
      this.deps.onError?.(new Error(`ended refused: ${ended.reason}`))
    // Proof is the executor's evidence (7.7b §7): an attempt it holds as unknown is settled as soon as this is recorded.
    else this.deps.onEnded?.(row.run_id)
  }

  /** The runtime stopped waiting for the run: the stop request for a launch that has no live handle (no `UnitRun`). */
  async stopUnattached(launchId: string, reason: StopReason = 'user'): Promise<boolean> {
    this.recordStop(launchId, reason)
    await this.stopSupervisor(launchId)
    const proof = await this.proveEnded(launchId, { timeoutMs: 5000 })
    const row = this.rowOf(launchId)
    if (!row) return true
    if (proof.proven) {
      if (row.phase !== 'ended' && row.phase !== 'settled')
        this.endRecord(row, proof.proof ?? 'unknown')
      this.markHeld(launchId, 0)
      return true
    }
    this.markHeld(launchId, 1)
    return false
  }

  /** Unsettled launches of one run (for a Stop that finds no live handle). */
  openLaunchesOf(runId: string, agentId?: string): string[] {
    return (
      this.deps.db.sqlite
        .prepare(
          "SELECT launch_id FROM coding_launches WHERE run_id = ? AND backend = 'unit' AND phase NOT IN ('ended','settled') AND (? IS NULL OR agent_id IS NULL OR agent_id = ?)",
        )
        .all(runId, agentId ?? null, agentId ?? null) as { launch_id: string }[]
    ).map((r) => r.launch_id)
  }
}
