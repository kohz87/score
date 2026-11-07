import type { DatabaseSync } from 'node:sqlite'
import { attemptsOf, isTerminalStatus, listOrchs } from './store.ts'

/** Orchestrations that hold capacity: running ones, and finished ones whose attempts are still not confirmed ended. */
export function capacityUsed(sqlite: DatabaseSync): number {
  return listOrchs(sqlite).filter(
    (o) =>
      !isTerminalStatus(o.status) ||
      attemptsOf(sqlite, o.id).some((a) => a.state === 'unknown' && a.abandoned_at === null),
  ).length
}

/** Storage reserved or stored by every orchestration, using the larger of the two for live runs. */
export function quotaUsed(sqlite: DatabaseSync): number {
  return listOrchs(sqlite).reduce(
    (sum, o) =>
      sum +
      (isTerminalStatus(o.status) ? o.stored_bytes : Math.max(o.reserve_bytes, o.stored_bytes)),
    0,
  )
}
