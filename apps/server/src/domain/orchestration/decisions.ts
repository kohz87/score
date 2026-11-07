// Human decisions (contract §14). Each is revision-bound: the page names the run revision it showed, and a stale one is
// a 409. Stop is the exception: it can only reduce risk, so it never waits on a stale page.

export { expectRevision } from './decision-guards.ts'
export { answerInquiry, decideGate } from './decision-gates.ts'
export { setLimits } from './decision-limits.ts'
export { answerQuota } from './decision-quota.ts'
export {
  abandonAttempts,
  grantWaiver,
  pauseRun,
  personStopsStep,
  resumeRun,
  stopRun,
} from './decision-run-controls.ts'
export { acceptCodingRemap, policyRemapStep, remapAgent } from './decision-remap.ts'
