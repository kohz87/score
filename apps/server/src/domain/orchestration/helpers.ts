// 3.15–3.16 (decision 150): helpers and votes. Helpers are agents the person named for narrow, read-only work: the lead
// hands them steps with a role (search, grep, audit), they can scan the folder before the lead's first turn, and they
// answer the lead's votes. Their steps run in their own slots (`maxConcurrent`) and allowance (`maxSteps`), outside the
// lead's step limit; everything else (gates, budget, admission, stops, recovery) is the ordinary step machinery.

export type { HelpersConfig } from './helpers-config.ts'
export {
  ROLE_PREAMBLE,
  effectiveSize,
  helperStepsLeft,
  helpersOf,
  insertHelperStep,
  startScan,
  usesHelperSlot,
  votersOf,
} from './helpers-config.ts'
export { autoAuditStep } from './helpers-audit.ts'
export { autoVoteStep, dropStepVote, stepVotePending } from './helpers-auto-votes.ts'
export { helperLines, helpersView, readChoice, settleHelpers, startVote } from './helpers-votes.ts'
