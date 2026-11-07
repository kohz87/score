import { pruneOrchestrationRows } from './prune.ts'
import {
  attemptsOf,
  isTerminalStatus,
  listOrchs,
  readAttempt,
  readOrch,
  type AttemptRow,
} from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000

export const maintenanceMethods = {
  // ------------------------------------------------------------------------------------------------- maintenance

  /** Daily: compacts reconciled journal entries and prunes finished, released runs older than the retention. */
  maintenance(this: OrchestratorRuntime): {
    journal: { kept: number; dropped: number }
    pruned: number
  } {
    const journal = this.options.fence.journal
    const sqlite = this.db.sqlite
    const holdKey = (e: { target: string; agentId?: string | undefined }) =>
      e.target === 'team' ? 'h:team' : `h:agent:${e.agentId}`
    const newest = new Map<string, number>()
    const own = journal.readOwn()
    if (own.ok)
      for (const entry of own.entries) {
        if (entry.kind === 'authorization') newest.set(`a:${entry.orchestrationId}`, entry.n)
        if (entry.kind === 'hold') newest.set(holdKey(entry), entry.n)
        if (entry.kind === 'remap')
          newest.set(`m:${entry.orchestrationId}:${entry.agentId}`, entry.n)
        if (entry.kind === 'renewal')
          newest.set(`r:${entry.orchestrationId}:${entry.nodeId}`, entry.n)
      }
    const compacted = journal.compact((entry) => {
      if (
        entry.kind === 'send_refused' ||
        entry.kind === 'send_closed' ||
        entry.kind === 'witness'
      ) {
        const attempt = readAttempt(sqlite, entry.attemptId)
        return (
          attempt !== undefined && (attempt.state === 'terminated' || attempt.state === 'refused')
        )
      }
      if (
        entry.kind === 'send_started' ||
        entry.kind === 'run_handle' ||
        entry.kind === 'reconciled'
      ) {
        const attempt = readAttempt(sqlite, entry.attemptId)
        return (
          attempt !== undefined && (attempt.state === 'terminated' || attempt.state === 'refused')
        )
      }
      if (entry.kind === 'transition') {
        const o = readOrch(sqlite, entry.orchestrationId)
        return (
          o !== undefined &&
          isTerminalStatus(o.status) &&
          attemptsOf(sqlite, o.id).every((x) => x.state === 'terminated' || x.state === 'refused')
        )
      }
      if (entry.kind === 'remap')
        return newest.get(`m:${entry.orchestrationId}:${entry.agentId}`) !== entry.n
      // Only the newest renewal per node is needed: it carries the count, and its successor is the node's attempt.
      if (entry.kind === 'renewal')
        return newest.get(`r:${entry.orchestrationId}:${entry.nodeId}`) !== entry.n
      if (entry.kind === 'authorization' || entry.kind === 'hold') {
        // Only the newest word per run / per target is needed; the older ones are superseded.
        return (
          newest.get(entry.kind === 'hold' ? holdKey(entry) : `a:${entry.orchestrationId}`) !==
          entry.n
        )
      }
      if (entry.kind === 'stop_fence') {
        // Only fully reconciled work lets a fence go: every attempt it covers is terminated (evidence) or never sent.
        const done = (a: AttemptRow) => a.state === 'terminated' || a.state === 'refused'
        if (entry.attemptId !== undefined) {
          const attempt = readAttempt(sqlite, entry.attemptId)
          return attempt !== undefined && done(attempt)
        }
        const o = readOrch(sqlite, entry.orchestrationId)
        if (!o || !isTerminalStatus(o.status)) return false
        return attemptsOf(sqlite, o.id).every(done)
      }
      return false
    })
    const cutoff = new Date(this.nowMs() - RETENTION_MS).toISOString()
    let pruned = 0
    // Each run is pruned in its own transaction: one that cannot be pruned never holds the others (or the quota) back.
    for (const candidate of this.db.read((sqlite) => listOrchs(sqlite))) {
      if (
        !isTerminalStatus(candidate.status) ||
        (candidate.ended_at ?? candidate.updated_at) >= cutoff
      )
        continue
      try {
        const done = this.db.tx((tx) => {
          const o = readOrch(tx, candidate.id)
          if (!o) return false
          if (attemptsOf(tx, o.id).some((x) => x.state !== 'terminated' && x.state !== 'refused'))
            return false
          if (
            attemptsOf(tx, o.id).some(
              (a) =>
                a.state === 'unknown' ||
                (a.stop_requested_at !== null && a.stop_acknowledged_at === null),
            )
          )
            return false
          pruneOrchestrationRows(tx, o, new Date(this.nowMs()).toISOString())
          return true
        })
        if (done) pruned++
      } catch (error) {
        this.err(error)
      }
    }
    return { journal: compacted, pruned }
  },
}

export type MaintenanceMethods = typeof maintenanceMethods

export type MaintenancePublicMethods = Pick<MaintenanceMethods, 'maintenance'>
