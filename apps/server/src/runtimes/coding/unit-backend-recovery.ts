import { join } from 'node:path'
import { codingProjection } from '../../domain/orchestration/coding-checkpoint.ts'
import {
  foldCodingLaunches,
  type CodingLaunch,
  type CodingState,
} from '../../domain/orchestration/coding-records.ts'
import { LAUNCHES_DIR } from '../../installation.ts'
import { UnitBackendLifecycle } from './unit-backend-lifecycle.ts'
import type { RecoveredLaunch, RecoveryReport } from './unit-backend-types.ts'
import { listInstallationUnits } from './units.ts'

export class UnitBackendRecovery extends UnitBackendLifecycle {
  // ---- recovery (§6b) -----------------------------------------------------------------------------------------------

  /**
   * Journal ↔ database ↔ live units ↔ receipts, before any admission. Every unsettled launch this installation owns
   * (its unit-name prefix and a journal launch that isn't a copied witness) is stopped through its recorded
   * supervisor and its end proven; launches copied from another installation are evidence only and never acted on; a launch that never reached `releasing` is revoked
   * (the journal proves no-launch); one that may have executed and can’t be proven is held. Units carrying this
   * installation's prefix that no journal launch owns are orphans: they fence admission and are never adopted.
   */
  async recover(): Promise<RecoveryReport> {
    if (this.deps.unresolved || this.deps.frozen?.() != null)
      return { launches: [], orphans: [], unreadable: null }
    const read = this.deps.journal.journal.readOwn()
    if (!read.ok)
      return {
        launches: [],
        orphans: [],
        unreadable: `the execution journal can’t be read (${read.reason})`,
      }
    const folded = foldCodingLaunches(read.entries)
    const withUnit = [...folded.values()].filter((l) => l.state.unit !== undefined)
    // Only this installation's own launches are acted on (review 2026-10-12 #2): the prefix alone is not enough, since
    // a copy keeps the source's unit names and InvocationIDs in its witnesses.
    const owned = withUnit.filter((l) => this.owns(l.state.launchId, l.state.unit))
    const inventory = await listInstallationUnits(this.run, this.prefix)
    // The phase, not the last record's kind: a waived launch's last record is `waived`, its phase `settled`.
    const open = owned.filter((l) => l.state.phase !== 'settled')
    if (inventory.kind === 'unknown' && open.length > 0) {
      for (const l of open) this.ensureRow(l)
      for (const l of open) this.markHeld(l.state.launchId, 1)
      return {
        launches: open.map((l) => this.report(l, false)),
        orphans: [],
        unreadable: `systemd can’t be read (${inventory.detail})`,
      }
    }
    const names = inventory.kind === 'ok' ? inventory.names : []
    const known = new Set(withUnit.map((l) => l.state.unit))
    this.orphans = names.filter((n) => !known.has(n))
    const launches: RecoveredLaunch[] = []
    for (const l of open) {
      this.ensureRow(l)
      launches.push(await this.recoverOne(l))
    }
    return { launches, orphans: [...this.orphans], unreadable: null }
  }

  protected report(l: CodingLaunch, ended: boolean): RecoveredLaunch {
    return {
      launchId: l.state.launchId,
      runId: l.state.runId,
      agentId: this.rowOf(l.state.launchId)?.agent_id ?? null,
      ended,
      mayHaveExecuted: l.state.mayHaveExecuted,
    }
  }

  /** A launch the journal knows but the database lacks (an older backup): a minimal row, so routing exists. */
  protected ensureRow(l: CodingLaunch): void {
    const id = l.state.launchId
    if (!this.rowOf(id)) {
      const project = codingProjection(this.deps.db, this.clock, (sqlite, state: CodingState) =>
        sqlite
          .prepare('UPDATE coding_launches SET receipt_dir = ? WHERE launch_id = ?')
          .run(join(this.deps.namespaceDir, LAUNCHES_DIR, state.launchId), state.launchId),
      )
      // Re-project the journal's own newest record.
      const entry = this.deps.journal.journal.readOwn()
      if (entry.ok) {
        const mine = entry.entries.findLast((e) => 'launchId' in e && e.launchId === id)
        if (mine) project(mine, l.state)
      }
    }
    // Routing a restored or rebuilt row lacks (the journal carries identity, not the agent): the run names its agent,
    // and a removed agent's launches keep their routing until settled (§6b). Where the run row is lost too, the routing
    // file beside the journal answers; with neither, the launch stays unattributed and fences all coding (`block`).
    const dir = join(this.deps.namespaceDir, LAUNCHES_DIR, id)
    const routing = this.readRouting(dir, id)
    this.deps.db.sqlite
      .prepare(
        `UPDATE coding_launches SET backend = COALESCE(backend, 'unit'),
           agent_id = COALESCE(agent_id, (SELECT profile FROM runs WHERE runs.id = coding_launches.run_id), ?),
           runtime = COALESCE(runtime, (SELECT runtime FROM runs WHERE runs.id = coding_launches.run_id), ?),
           receipt_dir = COALESCE(receipt_dir, ?)
         WHERE launch_id = ?`,
      )
      .run(routing?.agentId ?? null, routing?.runtime ?? null, dir, id)
  }

  protected async recoverOne(l: CodingLaunch): Promise<RecoveredLaunch> {
    const id = l.state.launchId
    // No `releasing` record: the journal proves the CLI never ran. Revoke so nothing can release it later.
    if (!l.state.mayHaveExecuted && !l.state.revoked)
      this.deps.journal.revoke(id, undefined, codingProjection(this.deps.db, this.clock), 'restart')
    await this.stopSupervisor(id)
    const proof = await this.proveEnded(id, { timeoutMs: this.deps.recoverProofMs ?? 10_000 })
    const row = this.rowOf(id)
    if (proof.proven && row) {
      if (l.kind !== 'ended') this.endRecord(row, proof.proof ?? 'unknown')
      this.markHeld(id, 0)
      return this.report(l, true)
    }
    // May have executed and not proven: unconfirmed. The agent is held; a loop keeps stopping it.
    this.markHeld(id, 1)
    return this.report(l, false)
  }
}
