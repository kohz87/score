// Small state transitions shared by the executor, the commands and the human decisions. Each takes the transaction's
// connection and writes only; callers decide when to commit and what to emit.

export {
  CODING_ITEM_EXTRA_BYTES,
  CODING_OUTPUT_BYTES,
  CODING_RESULT_BYTES,
  WORKFLOW_CODING_ITEM_BYTES,
  addCodingStored,
  addStored,
  chargeObservation,
  codingItemBytesOf,
  codingItemsFor,
  codingUnsentBytes,
  codingUnsentSlots,
  reserveFor,
  storageRoom,
  utf8Bytes,
} from './ops-storage.ts'
export { activeStepCounts, admissionRevision, bumpAdmission } from './ops-admission.ts'
export {
  cascadeBlocked,
  oweStop,
  refuseAttempt,
  retireQueued,
  setStepStatus,
  withdrawGates,
  withdrawInquiries,
} from './ops-steps.ts'
export { beginFinish, compactControlHistory } from './ops-finish.ts'
export { recordRefusal } from './ops-refusal.ts'
