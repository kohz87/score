import type { OwnershipState } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { HttpError } from '../../errors.ts'
import { attemptsOf, OrchRowSchema, type OrchRow } from './store.ts'
import { ownershipOf } from './views.ts'

// Ownership guards (contract §14 "Ownership and controls"): the room and brief of a run belong to the orchestration
// while it is `owned` and while it is `draining`; ordinary actions on them are rejected with `409 orchestration_owned`.

export interface Owner {
  orchestration: OrchRow
  state: OwnershipState
}

function ownerFrom(
  sqlite: DatabaseSync,
  column: 'room_id' | 'brief_id',
  id: string,
): Owner | undefined {
  const row = sqlite.prepare(`SELECT * FROM orchestrations WHERE ${column} = ?`).get(id)
  if (row === undefined) return undefined
  const orchestration = OrchRowSchema.parse(row)
  return { orchestration, state: ownershipOf(orchestration, attemptsOf(sqlite, orchestration.id)) }
}

export const ownerOfRoom = (sqlite: DatabaseSync, roomId: string): Owner | undefined =>
  ownerFrom(sqlite, 'room_id', roomId)
export const ownerOfBrief = (sqlite: DatabaseSync, briefId: string): Owner | undefined =>
  ownerFrom(sqlite, 'brief_id', briefId)

/** True while the object may not be touched by ordinary actions. */
export const isHeld = (owner: Owner | undefined): owner is Owner =>
  owner !== undefined && owner.state !== 'released'

export function assertNotOwned(owner: Owner | undefined, action: string): void {
  if (!isHeld(owner)) return
  throw new HttpError(
    409,
    'orchestration_owned',
    'This belongs to an orchestration run; use the run controls instead',
    { orchestrationId: owner.orchestration.id, state: owner.state, action },
  )
}

export function assertRoomFree(sqlite: DatabaseSync, roomId: string, action: string): void {
  assertNotOwned(ownerOfRoom(sqlite, roomId), action)
}
export function assertBriefFree(sqlite: DatabaseSync, briefId: string, action: string): void {
  assertNotOwned(ownerOfBrief(sqlite, briefId), action)
}

/** The brief a Hermes run belongs to, via its reply row (null for runs outside any brief). */
export function briefOfRun(sqlite: DatabaseSync, runId: string): string | null {
  const row = sqlite.prepare('SELECT chain_id FROM message_runs WHERE run_id = ?').get(runId) as
    { chain_id: string } | undefined
  return row?.chain_id ?? null
}
