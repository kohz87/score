import type { ReportRange } from '@score/contract'

/** One kanban task as Hermes recorded it (times in epoch ms). */
export interface KanbanTaskFact {
  id: string
  assignee: string | null
  status: string
  createdAt: number
  completedAt: number | null
  hasParents: boolean
  /**
   * review_requested, changes_requested, completed, promoted, blocked, unblocked. `id` is Hermes' event id: order
   * is by id, never by `at` alone (several events share a second). `actor` is the profile that owned the wait the
   * event opens (the implementer on review_requested), null when Hermes did not record one.
   */
  events: { id: number; kind: string; at: number; actor: string | null }[]
}

/** What Hermes knows that Score's own tables do not (read-only, through the adapter). */
export interface ReportFacts {
  tasks: KanbanTaskFact[]
  /** Spend per agent in the window; null when that agent's cost data is unavailable. */
  spendUsd: Record<string, number | null>
  /** Prompt-token counts per agent in the window; null/absent = Hermes gives no cache tokens (shown as "—"). */
  cache?: Record<string, CacheTokens | null>
}

/** `read` = tokens served from the prompt cache; `total` = read + written + uncached input. */
export interface CacheTokens {
  read: number
  total: number
}

export interface ReportRun {
  agentId: string
  startedAt: string
  endedAt: string | null
  /** False for a Kanban attempt whose claim could not be proven: counted as a run, never as working time. */
  work?: boolean
  /** Observed stretches of a Kanban attempt: the gaps between them are not working time. */
  observed?: { startedAt: string; endedAt: string | null }[]
}
/** A Kanban attempt for reports (5.17a-1). `endedAt` is where it ended or where observation stopped; null = running. */
export interface ReportAttempt {
  agentId: string | null
  startedAt: string
  endedAt: string | null
  evidence: 'proven' | 'partial'
  observed?: { startedAt: string; endedAt: string | null }[]
}

export interface ReportApproval {
  agentId: string
  stage: 'guardian' | 'human'
  visible: boolean
  status: string
  decisionBy: string | null
  createdAt: string
  decidedAt: string | null
  closedAt: string | null
}

export interface ReportWindow {
  from: number
  to: number
  /** Local calendar days (YYYY-MM-DD) covered, oldest first. */
  days: string[]
}

/** Inclusive local days (YYYY-MM-DD) of a custom range. */
export interface CustomDays {
  from: string
  to: string
}

export interface ReportInput {
  range: ReportRange
  custom?: CustomDays
  now: number
  tz?: string
  agentIds: string[]
  runs: ReportRun[]
  /** Present only with Kanban attempts enabled; absent leaves the report exactly as before. */
  attempts?: ReportAttempt[]
  approvals: ReportApproval[]
  facts: ReportFacts
}
