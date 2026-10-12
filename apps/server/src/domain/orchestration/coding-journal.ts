import type { ExecutionJournal, JournalEntry } from './journal.ts'
import {
  nextState,
  sameIdentity,
  transitionAllowed,
  type CodingIdentity,
  type CodingLaunch,
  type CodingPatch,
  type CodingRecordKind,
  type CodingState,
} from './coding-records.ts'

// The coding-run side of the journal (7.7a design v7 §3). Every method is one `journal.critical` section: authority
// read → CAS → append + fsync → database projection, all under the journal's OS lock. The projection callback is where
// the caller commits its database change; whatever it does, the record is already durable.

export type CodingRejection =
  | 'illegal_transition' // the launch's newest record does not allow this one (including a repeat)
  | 'identity_mismatch' // run/turn/generation differ from the launch's first record
  | 'revoked' // a revoked launch can only be stopped and settled
  | 'may_have_executed' // `releasing` won the race: revocation is a Stop of a possibly-executing run
  | 'not_authorised' // the run's authorisation no longer holds (re-evaluated under the lock)
  | 'turn_witnessed' // the journal already witnessed this turn executing (another launch, same or later generation)
  | 'unknown_launch'
  | 'projection_failed' // the record is durable but the database commit failed: do NOT send `go`

export type CodingResult =
  | { ok: true; entry: JournalEntry; state: CodingState }
  | { ok: false; reason: CodingRejection; state?: CodingState; cause?: unknown }

/** Runs inside the critical section after the record is durable; throwing means "the database did not commit". */
export type Projection = (entry: JournalEntry, state: CodingState) => void

export class CodingJournal {
  constructor(readonly journal: ExecutionJournal) {}

  /** A launch's newest state, read under the lock. */
  state(launchId: string): CodingLaunch | undefined {
    return this.journal.critical((tx) => tx.launch(launchId))
  }

  /** `requested`: before `systemd-run`. A revoked launch can never be requested again. */
  requestLaunch(
    identity: CodingIdentity,
    project?: Projection,
    /** The exact unit name goes into the first record (part 3: never derived again). */
    patch: CodingPatch = {},
  ): CodingResult {
    return this.step(identity.launchId, 'launch-requested', identity, patch, project)
  }

  /** `armed`: Score has verified the supervisor's identity (§5). */
  arm(launchId: string, patch: CodingPatch, project?: Projection): CodingResult {
    return this.step(launchId, 'armed', undefined, patch, project)
  }

  /**
   * The ordering point (§3). Under the lock: (1) the launch is `armed`, not revoked, and `stillAuthorised()` (evaluated
   * inside the section) holds; (2) append + fsync `releasing`, from which the launch MAY HAVE EXECUTED, monotonic;
   * (3) the database projection. The caller sends `go` only after this returns ok. If (3) fails the launch stays
   * "may have executed" (`projection_failed`): no `go`, but never again "no launch".
   */
  release(launchId: string, stillAuthorised: () => boolean, project?: Projection): CodingResult {
    return this.step(launchId, 'releasing', undefined, {}, project, stillAuthorised)
  }

  /** Revocation is the same critical section: it appends `revoked` only when no `releasing` record exists. */
  revoke(launchId: string, identity?: CodingIdentity, project?: Projection): CodingResult {
    return this.step(launchId, 'revoked', identity, {}, project)
  }

  /** Score read the supervisor's `released` receipt. */
  releasedSeen(launchId: string, patch: CodingPatch = {}, project?: Projection): CodingResult {
    return this.step(launchId, 'released-seen', undefined, patch, project)
  }

  /** Ended proof was obtained (§6): `proof` says how. */
  ended(launchId: string, patch: CodingPatch, project?: Projection): CodingResult {
    return this.step(launchId, 'ended', undefined, patch, project)
  }

  /** The terminal result and disposition were committed. */
  settled(launchId: string, patch: CodingPatch, project?: Projection): CodingResult {
    return this.step(launchId, 'settled', undefined, patch, project)
  }

  private step(
    launchId: string,
    kind: CodingRecordKind,
    identity: CodingIdentity | undefined,
    patch: CodingPatch,
    project: Projection | undefined,
    stillAuthorised?: () => boolean,
  ): CodingResult {
    return this.journal.critical((tx): CodingResult => {
      const current = tx.launch(launchId)
      if (current === undefined && identity === undefined)
        return { ok: false, reason: 'unknown_launch' }
      const id = identity ?? current!.state
      if (current && identity && !sameIdentity(current.state, identity))
        return { ok: false, reason: 'identity_mismatch', state: current.state }
      if (current?.violation !== undefined)
        return { ok: false, reason: 'illegal_transition', state: current.state }
      if (
        current &&
        kind !== 'revoked' &&
        current.state.revoked &&
        kind !== 'ended' &&
        kind !== 'settled'
      )
        return { ok: false, reason: 'revoked', state: current.state }
      if (kind === 'revoked' && current?.state.mayHaveExecuted)
        return { ok: false, reason: 'may_have_executed', state: current.state }
      if (kind === 'launch-requested' && current?.state.revoked)
        return { ok: false, reason: 'revoked', state: current.state }
      // A permanent witness makes the TURN unsendable, not only its launch: a restored database that lost the intent and
      // the run must not mint a new launch for the same turn (checked again at release, under the same lock).
      if (kind === 'launch-requested' || kind === 'releasing') {
        const witnessed = tx
          .launchesOfTurn(id.turnId)
          .find(
            (other) =>
              other.state.launchId !== id.launchId &&
              other.state.mayHaveExecuted &&
              other.state.generation >= id.generation,
          )
        if (witnessed) return { ok: false, reason: 'turn_witnessed', state: witnessed.state }
      }
      if (!transitionAllowed(current?.kind, kind))
        return {
          ok: false,
          reason: 'illegal_transition',
          ...(current ? { state: current.state } : {}),
        }
      if (stillAuthorised && !stillAuthorised())
        return { ok: false, reason: 'not_authorised', ...(current ? { state: current.state } : {}) }
      const state = nextState(current?.state, id, kind, patch)
      const entry = tx.append({ kind, ...state } as Parameters<typeof tx.append>[0])
      try {
        project?.(entry, state)
      } catch (cause) {
        // The record is durable; whatever the database holds, the journal's word stands.
        return { ok: false, reason: 'projection_failed', state, cause }
      }
      return { ok: true, entry, state }
    })
  }
}
