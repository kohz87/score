import type { DatabaseSync } from 'node:sqlite'
import { ORCH_LIMITS, WORKFLOW_LIMITS } from '@score/contract'
import type { OrchRow } from './store.ts'

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/**
 * Room for ordinary text and observations in a run: its reserve minus the protected part kept for Stop and obligation
 * records, minus the part held for coding inventory (unless coding inventory already spilled past its own part, in which
 * case the spill is counted as ordinary use).
 */
export const storageRoom = (
  o: Pick<
    OrchRow,
    'reserve_bytes' | 'stored_bytes' | 'coding_reserve_bytes' | 'coding_stored_bytes'
  >,
): number =>
  o.reserve_bytes -
  ORCH_LIMITS.controlReserveBytes -
  o.coding_reserve_bytes -
  (o.stored_bytes - Math.min(o.coding_stored_bytes, o.coding_reserve_bytes))

export function addStored(sqlite: DatabaseSync, orchId: string, bytes: number): void {
  sqlite
    .prepare('UPDATE orchestrations SET stored_bytes = stored_bytes + ? WHERE id = ?')
    .run(bytes, orchId)
}

/** Coding inventory (a coding step's result, retained input and run result): charged to the coding part of the reserve. */
export function addCodingStored(sqlite: DatabaseSync, orchId: string, bytes: number): void {
  sqlite
    .prepare(
      'UPDATE orchestrations SET stored_bytes = stored_bytes + ?, coding_stored_bytes = coding_stored_bytes + ? WHERE id = ?',
    )
    .run(bytes, bytes, orchId)
}

/** The reserve a run takes at creation: steps and lead turns at 64 KiB each plus the control reserve. */
export const reserveFor = (
  maxSteps: number,
  maxLeadTurns: number,
  codingItems = 0,
  codingUnsent = 0,
): number =>
  (maxSteps + maxLeadTurns) * (ORCH_LIMITS.storagePerItemBytes + ORCH_LIMITS.recordsPerItemBytes) +
  ORCH_LIMITS.controlReserveBytes +
  codingItems * CODING_ITEM_EXTRA_BYTES +
  codingUnsent

/** One kept copy of a coding result (the translator's cap), and the run output kept beside it. */
export const CODING_RESULT_BYTES = 32 * 1024
export const CODING_OUTPUT_BYTES = 8 * 1024
/** A step result is the kept reply plus a short cut notice, bounded at this much. */
const CODING_RESULT_COPY_BYTES = CODING_RESULT_BYTES + 128

/**
 * What a coding worker item reserves beyond an ordinary step (design §11, F2 #4): everything one item can retain, so
 * inventory never reaches the control reserve. One retained input (the step input cap), the step result and the attempt
 * result (two copies), the retained reply (`coding_run_results`), the run output, and 2 KiB for each of up to 20
 * dispatch generations. Independent of the observation pool, so terminal state, proof, refusal receipt and Stop always fit.
 */
export const CODING_ITEM_EXTRA_BYTES =
  ORCH_LIMITS.stepInputBytes +
  2 * CODING_RESULT_COPY_BYTES +
  CODING_RESULT_BYTES +
  CODING_OUTPUT_BYTES +
  20 * 2 * 1024

/**
 * What one coding item of a WORKFLOW reserves (7.7c §5): everything an orchestration's item keeps, plus the two copies a
 * workflow adds (the `wf_results` output and the node's own output, 32 KiB each), the verdict record (2 KiB) and the
 * generation records of the renewals the person may ask for (each renewal is a fresh attempt with up to 20 generations).
 * Computed from the constants, so the partition can never drift from what is written into it.
 */
export const WORKFLOW_CODING_ITEM_BYTES =
  CODING_ITEM_EXTRA_BYTES +
  2 * WORKFLOW_LIMITS.outputBytes +
  2 * 1024 +
  WORKFLOW_LIMITS.maxRenewalsPerNode * 20 * 2 * 1024

/** The coding item size of a run, by its planner: a workflow's items hold more than an orchestration's. */
export const codingItemBytesOf = (planner: 'lead' | 'workflow'): number =>
  planner === 'workflow' ? WORKFLOW_CODING_ITEM_BYTES : CODING_ITEM_EXTRA_BYTES

/**
 * The room a run keeps for the retained inputs of coding attempts that were prepared but not sent (7.7c F1 #6). Launches
 * are bounded by `codingSteps`, but attempts that wait unsent (blocked for a decision, or queued behind the concurrency
 * limit) each keep their frozen input, so that inventory has its own bound: twice the run's concurrency, never more than
 * its steps. Independent of `codingSteps`: raising the limit never changes it, and a step past it is parked unprepared.
 */
export const codingUnsentSlots = (maxSteps: number, maxConcurrentSteps: number): number =>
  Math.min(maxSteps, 2 * maxConcurrentSteps)
export const codingUnsentBytes = (maxSteps: number, maxConcurrentSteps: number): number =>
  codingUnsentSlots(maxSteps, maxConcurrentSteps) * ORCH_LIMITS.stepInputBytes

/** A run can release at most `codingSteps` launches, and each coding item needs one, so that bounds the items. */
export const codingItemsFor = (maxSteps: number, codingSteps: number): number =>
  Math.min(maxSteps, codingSteps)

/**
 * Observed tool and thinking rows of an orchestration attempt's run are retained with the run, so they are charged to its
 * allowance at the writer (v8.1 item 5). Returns false when the run has no room left (the protected reserve for Stop and
 * obligation evidence is never spent here): the writer then drops the row. Runs outside any orchestration are unbounded.
 */
export function chargeObservation(sqlite: DatabaseSync, runId: string, bytes: number): boolean {
  const owner = sqlite
    .prepare(
      `SELECT o.id AS id, o.reserve_bytes AS reserve_bytes, o.stored_bytes AS stored_bytes,
              o.coding_reserve_bytes AS coding_reserve_bytes, o.coding_stored_bytes AS coding_stored_bytes FROM message_runs m
       JOIN orc_attempts a ON a.id = m.orchestration_attempt_id JOIN orchestrations o ON o.id = a.orchestration_id
       WHERE m.run_id = ?`,
    )
    .get(runId) as
    | {
        id: string
        reserve_bytes: number
        stored_bytes: number
        coding_reserve_bytes: number
        coding_stored_bytes: number
      }
    | undefined
  if (!owner) return true
  if (bytes > storageRoom(owner)) return false
  addStored(sqlite, owner.id, bytes)
  return true
}
