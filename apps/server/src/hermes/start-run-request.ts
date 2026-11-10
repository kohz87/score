import type { OrchestrationOwner } from '../domain/orchestration/owner.ts'

export interface StartRunRequest {
  agentId: string
  input: string
  turnId: string
  sessionId?: string
  model?: string
  /** Decision 178: this chat's effort for the agent; absent = the agent's own. */
  effort?: string
  /** The job whose subagent limits the run works under (decision 173). */
  jobId?: string
  /** Per-request provider (an alias's own); Hermes honours it with or without `model`. */
  provider?: string
  /** Media ids of the person's image attachments, in message order. */
  images?: string[]
  /**
   * Orchestration dispatch (PLAN 7.5): the executor owns recovery of this admission, so generic intent recovery must
   * never resend it.
   */
  owner?: 'orchestration' | OrchestrationOwner
  /**
   * Applied to the stored input only for the payload sent to Hermes, in memory. The orchestrator uses it to insert a
   * per-turn capability that must never be stored.
   */
  render?: (stored: string) => string
}
