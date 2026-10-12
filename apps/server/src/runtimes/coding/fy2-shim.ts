// FY2: batch FY2 adds `CodingJournal.recordStop`, `waive` and `isOwned` (plus the `inherited` flag on records). Until
// that merges, this shim gives this branch the same three names so the runtime layer can call them and be tested. The
// lead deletes this file (and its two imports, in unit-backend.ts and service.ts) when reconciling the branches.
import {
  CodingJournal,
  type CodingResult,
  type Projection,
} from '../../domain/orchestration/coding-journal.ts'

export type StopCause = string

declare module '../../domain/orchestration/coding-journal.ts' {
  interface CodingJournal {
    /** Appends a fsynced `stop-requested` record (first cause wins) before any signal is sent. */
    recordStop(launchId: string, cause: StopCause, project?: Projection): CodingResult
    /** Appends `waived` and settles the launch (disposition `waived`) in one critical section. */
    waive(launchId: string, by: string, project?: Projection): CodingResult
    /** False for a witness copied from another installation (`inherited`): never acted on. */
    isOwned(launchId: string): boolean
  }
}

const proto = CodingJournal.prototype as Partial<CodingJournal>
// FY2: no `stop-requested` record exists here yet; callers also write the database column themselves.
proto.recordStop ??= function (this: CodingJournal, launchId: string): CodingResult {
  const state = this.state(launchId)
  return state
    ? { ok: true, entry: undefined as never, state: state.state }
    : { ok: false, reason: 'unknown_launch' }
}
// FY2: the closest records that exist today: `ended` (waiver) then `settled` (disposition waived).
proto.waive ??= function (
  this: CodingJournal,
  launchId: string,
  _by: string,
  project?: Projection,
): CodingResult {
  const ended = this.ended(launchId, { proof: 'waiver', waiver: true }, project)
  if (!ended.ok && ended.reason !== 'illegal_transition') return ended
  return this.settled(launchId, { disposition: 'waived' }, project)
}
// FY2: no inherited witnesses exist before FY2; every launch of this namespace is ours.
proto.isOwned ??= () => true
