import { z } from 'zod'
import { CodingRuntimeStops } from './service-stops.ts'
import { ProcessRow, TERMINAL_NOTE, UNRESOLVED_NOTE } from './service-types.ts'
import { newTranslation } from './translate.ts'

export class CodingRuntime extends CodingRuntimeStops {
  async recover(): Promise<number> {
    const { db } = this.deps
    await this.commitPendingTerminals()
    // Children can outlive a crashed Score: stop what is left of each recorded group before admitting anything. A
    // record goes only when the group is proven gone; otherwise it stays (the agent takes no new turn), the run says
    // so, and Score keeps trying in the background.
    const records = db.sqlite
      .prepare('SELECT * FROM coding_processes')
      .all()
      .map((row) => ProcessRow.parse(row))
    const unresolved = new Set<string>()
    // Supervised units first (journal <-> database <-> units <-> receipts, design §6b): each unsettled launch is
    // stopped and proven ended; one that may have executed and can't be proven is held, like an unresolved group.
    const unit = this.deps.unit
    const recovered = unit ? await unit.recover() : null // reports nothing (and signals nothing) while frozen
    if (recovered) {
      if (recovered.unreadable) this.deps.onError?.(new Error(recovered.unreadable))
      if (recovered.orphans.length > 0) this.deps.onOrphans?.(recovered.orphans)
      for (const launch of recovered.launches)
        if (!launch.ended) {
          unresolved.add(launch.runId)
          void unit!.reap(launch.launchId, this.deps.reapRetryMs)
        }
    }
    for (const record of records) {
      if (!this.ownsRow(record.run_id)) continue
      const outcome = await this.stopGroup(record)
      if (outcome === 'gone') this.forgetProcess(record.run_id)
      else {
        unresolved.add(record.run_id)
        db.sqlite
          .prepare('UPDATE coding_processes SET unresolved = 1, unobservable = ? WHERE run_id = ?')
          .run(outcome === 'unobservable' ? 1 : 0, record.run_id)
        void this.reapInBackground(record.run_id)
      }
    }
    const rows = z
      .array(z.object({ id: z.string(), profile: z.string() }))
      .parse(
        db.sqlite
          .prepare(
            "SELECT id, profile FROM runs WHERE runtime != 'hermes' AND status IN ('queued','running','waiting_for_approval')",
          )
          .all(),
      )
    for (const row of rows) {
      const turn = db.sqlite
        .prepare('SELECT job_id FROM message_runs WHERE run_id = ?')
        .get(row.id) as { job_id: string } | undefined
      await this.finish(newTranslation(row.id, row.profile, turn?.job_id ?? null), {
        status: 'interrupted',
        error: unresolved.has(row.id)
          ? `${TERMINAL_NOTE.interrupted} ${UNRESOLVED_NOTE}`
          : TERMINAL_NOTE.interrupted,
        costKind: 'unknown',
        ...(unresolved.has(row.id) ? { group: 'unconfirmed' as const } : {}),
      })
    }
    // Launches whose end is proven but whose run was already terminal (a crash between the result and `settled`).
    if (recovered && unit)
      for (const launch of recovered.launches)
        if (launch.ended)
          await unit
            .settleRun(launch.runId, 'interrupted')
            .catch((e: unknown) => this.deps.onError?.(e))
    // Anything still pending belongs to a run that is terminal now (or was interrupted just above).
    db.sqlite
      .prepare(
        "DELETE FROM coding_pending_terminals WHERE run_id IN (SELECT id FROM runs WHERE status NOT IN ('queued','running','waiting_for_approval'))",
      )
      .run()
    return rows.length
  }

  /** Server shutdown: stop the children and record the turns as interrupted. */
  async close(): Promise<void> {
    this.closed = true
    const entries = [...this.active.values()]
    for (const entry of entries) this.requestStop(entry, 'shutdown')
    await Promise.allSettled([...this.queues.values()])
    for (const wake of [...this.wakers]) wake()
    await this.deps.unit?.close()
    await Promise.allSettled([...this.reapers.values(), ...this.deliveries.values()])
  }
  get isClosed(): boolean {
    return this.closed
  }
}
