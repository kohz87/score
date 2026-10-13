// The owner of a coding launch (7.7b §5): an orchestration attempt's dispatch generation. The executor builds it in
// `beginSend`, the coding runtime hands it to the unit backend, and the backend asks `authorise` at the ordering point.

/** The executor's answer at the release critical section: yes, or no with a typed cause (design §6). */
export type ReleaseDecision = { allowed: true } | { allowed: false; cause: string }

export interface OrchestrationOwner {
  kind: 'orchestration'
  orchestrationId: string
  attemptId: string
  generation: number
  /** The launch id minted with the generation; the unit backend uses it, so the executor knows it before anything runs. */
  launchId: string
  /** The orchestration's absolute deadline (epoch ms), or null. The supervisor's expiry never exceeds it. */
  deadlineAt: number | null
  /** Common admission rules + phase guard + prepared spec. Never writes, never awaits; reads in its own transaction. */
  authorise(prepared: { expiry: number }): ReleaseDecision
}
