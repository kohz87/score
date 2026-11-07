import { createHash, randomUUID } from 'node:crypto'
import { type DomainEventDraft } from '../../hub/ingest.ts'
import { emitBriefChange } from '../briefs.ts'
import { type Ctx } from './ctx.ts'
import { fenceView } from './fence.ts'
import { compactControlHistory } from './ops.ts'
import { workflowDetailOf, workflowSummaryOf } from '../workflows/views.ts'
import { addHistory, attemptsOf, isTerminalStatus, listOrchs, readOrch } from './store.ts'
import { detailOf, ownershipOf, summaryOf } from './views.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'

const SWEEP_MS = 10_000

export const lifecycleMethods = {
  // ---------------------------------------------------------------------------------------------------- lifecycle

  /** Crash recovery, then event-driven operation plus a periodic sweep. */
  async start(this: OrchestratorRuntime): Promise<void> {
    await this.recover()
    if (this.options.fence.view().fenced) this.announceFence()
    const maintain = () => {
      try {
        this.maintenance()
      } catch (error) {
        this.err(error)
      }
    }
    maintain()
    this.maintenanceTimer = setInterval(maintain, 24 * 60 * 60 * 1000)
    this.maintenanceTimer.unref()
    this.unsubscribe = this.ingest.onCommitted((events) => {
      if (events.some((event) => event.type === 'run.updated')) this.kick()
    })
    this.timer = setInterval(() => this.kick(), SWEEP_MS)
    this.timer.unref()
    this.kick()
  },

  async close(this: OrchestratorRuntime): Promise<void> {
    this.closed = true
    this.unsubscribe?.()
    clearInterval(this.timer)
    clearInterval(this.maintenanceTimer)
    await this.pumping?.catch(() => undefined)
    // A check still running is stopped with its process group; the next start records it as interrupted.
    // Killed outright: the process is about to exit, so a grace timer would never fire.
    for (const job of this.checkJobs.values()) job.proc.stop(true)
    // Stops in flight get up to 5 s to answer; the rest stay durably owed and are asked again after the next start.
    if (this.stopJobs.size > 0) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled([...this.stopJobs.values()]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.options.stopDrainMs ?? 5_000)
        }),
      ])
      clearTimeout(timer)
      this.abandonStops = true
    }
  },

  err(this: OrchestratorRuntime, error: unknown): void {
    this.options.onError?.(error)
  },

  kick(this: OrchestratorRuntime): void {
    if (this.closed) return
    void this.pump().catch((error: unknown) => this.err(error))
  },

  /** Runs the executor until it has nothing left to do right now. Concurrent calls share one run. */
  pump(this: OrchestratorRuntime): Promise<void> {
    if (this.pumping) {
      this.again = true
      return this.pumping
    }
    this.pumping = (async () => {
      do {
        this.again = false
        await this.cycle()
      } while (this.again && !this.closed)
    })().finally(() => {
      this.pumping = undefined
    })
    return this.pumping
  },

  /**
   * v8.2 item 1: an agent that becomes served again (a version check or gateway reachability recovering) wakes the
   * attempts that waited out refusals. Only asked while some attempt is in that wait.
   */
  readinessWaiting(this: OrchestratorRuntime): boolean {
    return this.db.read(
      (sqlite) =>
        sqlite
          .prepare(
            "SELECT 1 FROM orc_attempts WHERE state = 'created' AND refused_streak > 0 AND needs_person = 0 LIMIT 1",
          )
          .get() !== undefined,
    )
  },

  async observeReadiness(this: OrchestratorRuntime): Promise<void> {
    try {
      for (const agent of await this.options.port.listAgents()) {
        const before = this.served.get(agent.id)
        this.served.set(agent.id, agent.served)
        if (before === false && agent.served) await this.agentReady(agent.id)
      }
    } catch (error) {
      this.err(error)
    }
  },

  async cycle(this: OrchestratorRuntime): Promise<void> {
    // Not awaited when nothing waits, so the cycle starts in the same tick as before.
    if (this.readinessWaiting()) await this.observeReadiness()
    for (let round = 0; round < 100 && !this.closed; round++) {
      let progressed = await this.reconcile()
      const live = this.db.read((sqlite) =>
        listOrchs(sqlite).some((o) => !isTerminalStatus(o.status)),
      )
      if (live) await this.mutate((ctx) => this.sweep(ctx))
      // Not awaited unless a queued Antigravity step needs a fresh reading (tests rely on the cycle's tick order).
      const refreshing = this.refreshQuota()
      if (refreshing) await refreshing
      const jobs = await this.mutate((ctx) => this.admit(ctx))
      for (const id of jobs) progressed = (await this.dispatch(id)) || progressed
      progressed = (await this.serviceStops()) || progressed
      progressed = (await this.serviceChecks()) || progressed
      if (!progressed) return
    }
  },

  /** Test aid: resolves once the executor is idle. */
  async idle(this: OrchestratorRuntime): Promise<void> {
    while (this.pumping) await this.pumping
  },

  nowMs(this: OrchestratorRuntime): number {
    return this.clock()
  },

  // -------------------------------------------------------------------------------------------------- transactions

  async mutate<T>(this: OrchestratorRuntime, fn: (ctx: Ctx) => T): Promise<T> {
    let result!: T
    let failure: string | undefined
    // Cache updates are staged and published only once the transaction has committed; a rollback must not leave
    // "already seen" marks behind for projections that were never stored.
    const staged = { fingerprints: new Map<string, string>(), ownership: new Map<string, string>() }
    await this.ingest.submit({
      source: 'orchestration',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        const ctx: Ctx = {
          sqlite,
          now,
          journal: this.options.fence.journal,
          touched: new Set(),
          events: [],
          ...(this.options.codingFacts?.quota ? { quota: this.options.codingFacts.quota } : {}),
        }
        result = fn(ctx)
        const events = [...ctx.events, ...this.finalize(ctx, staged)]
        failure = ctx.journalFailure
        return events
      },
    })
    for (const [id, value] of staged.fingerprints) this.fingerprints.set(id, value)
    for (const [id, value] of staged.ownership) this.ownershipSeen.set(id, value)
    if (failure !== undefined) this.fenceNow('journal_unwritable', failure)
    return result
  },

  fenceNow(this: OrchestratorRuntime, reason: string, detail: string): void {
    try {
      this.options.fence.set(reason, [{ kind: 'journal', ref: 'journal', journalN: null, detail }])
    } catch (error) {
      this.err(error)
    }
  },

  /** Settles each touched run, bumps its revision when anything changed and emits its summary. */
  finalize(
    this: OrchestratorRuntime,
    ctx: Ctx,
    staged: { fingerprints: Map<string, string>; ownership: Map<string, string> },
  ): DomainEventDraft[] {
    const { sqlite, now } = ctx
    const events: DomainEventDraft[] = []
    for (let pass = 0; pass < 4; pass++) {
      let changed = false
      for (const id of [...ctx.touched]) changed = this.settle(ctx, id) || changed
      if (!changed) break
    }
    for (const id of ctx.touched) {
      const o = readOrch(sqlite, id)
      if (!o) continue
      const workflow = o.planner === 'workflow'
      const fingerprint = createHash('sha1')
        .update(
          JSON.stringify({
            ...(workflow
              ? workflowDetailOf(sqlite, o, now, {
                  lineageProvable: this.lineageProvable,
                  skipStorage: true,
                  ...(this.options.codingFacts ? { facts: this.options.codingFacts } : {}),
                })
              : detailOf(sqlite, o)),
            revision: 0,
            updatedAt: '',
          }),
        )
        .digest('hex')
      if ((staged.fingerprints.get(id) ?? this.fingerprints.get(id)) === fingerprint) continue
      staged.fingerprints.set(id, fingerprint)
      // Ownership transitions (owned, draining, released) are part of the recorded history.
      const ownership = ownershipOf(o, attemptsOf(sqlite, o.id))
      if ((staged.ownership.get(id) ?? this.ownershipSeen.get(id)) !== ownership) {
        staged.ownership.set(id, ownership)
        addHistory(sqlite, id, 'ownership', { state: ownership }, now)
      }
      compactControlHistory(sqlite, id)
      sqlite
        .prepare('UPDATE orchestrations SET revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(now, id)
      const fresh = readOrch(sqlite, id)!
      events.push(
        workflow
          ? {
              type: 'workflow.run.upserted',
              data: workflowSummaryOf(
                sqlite,
                fresh,
                this.options.fence.journal,
                this.options.codingFacts,
              ),
            }
          : { type: 'orchestration.upserted', data: summaryOf(sqlite, fresh) },
      )
      events.push(...emitBriefChange(sqlite, o.brief_id))
    }
    return events
  },

  /** Emits the global fence to the stream (set at start, by a journal failure, or lifted by the person). */
  announceFence(this: OrchestratorRuntime): void {
    void this.ingest
      .submit({
        source: 'orchestration',
        identity: randomUUID(),
        apply: ({ sqlite }) => [
          {
            type: 'orchestration.fence.updated',
            data: fenceView(sqlite, this.options.fence.journal),
          },
        ],
      })
      .catch((error: unknown) => this.err(error))
  },
}

export type LifecycleMethods = typeof lifecycleMethods

export type LifecyclePublicMethods = Pick<
  LifecycleMethods,
  'start' | 'close' | 'kick' | 'pump' | 'idle'
>
