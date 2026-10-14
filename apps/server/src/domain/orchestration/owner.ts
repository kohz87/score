import type { WorkerPolicy } from '../../runtimes/coding/policy.ts'

// The owner of a coding launch (7.7b §5): an orchestration attempt's dispatch generation. The executor builds it in
// `beginSend`, the coding runtime hands it to the unit backend, and the backend asks `authorise` at the ordering point.

/** The executor's answer at the release critical section: yes, or no with a typed cause (design §6). */
export type ReleaseDecision = { allowed: true } | { allowed: false; cause: string }

/** What the release decision may ask the journal inside its critical section (a read of the folded launches). */
export interface OwnedLaunchJournal {
  /** Launches of this orchestration that may have executed (`releasing` or later); revoked ones never count (M4). */
  executedBy(orchestrationId: string): number
}

/** What the launch was prepared with: its absolute expiry and the id of the policy its invocation was built from. */
export interface PreparedLaunch {
  expiry: number
  policyId?: string
}

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
  authorise(prepared: PreparedLaunch, journal: OwnedLaunchJournal): ReleaseDecision
  /** A coding worker's stored policy: the invocation is built from it, never from the live agent row (7.7b §3). */
  policy?: { id: string; policy: WorkerPolicy }
}
