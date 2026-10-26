import type { AgentSummary, AttemptStatus, AttemptSummary } from '@score/contract'

/** The one line for a legacy Kanban run link that no attempt could be proven for. */
export const EARLIER_ATTEMPT_TEXT = 'An earlier run (details not kept)'

export const attemptStatusLabel: Record<AttemptStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
  review_handoff: 'Handed to review',
  changes_requested: 'Changes requested',
  ended_unknown: 'Not confirmed as ended',
}

export const evidenceLabel: Record<AttemptSummary['evidence'], string> = {
  proven: 'Confirmed',
  partial: 'Source unclear',
}

export function attemptAgentName(
  attempt: Pick<AttemptSummary, 'agentId'>,
  agents: Pick<AgentSummary, 'id' | 'name'>[] | undefined,
): string {
  if (attempt.agentId === null) return 'Unknown agent'
  return agents?.find((agent) => agent.id === attempt.agentId)?.name ?? attempt.agentId
}

/**
 * Where an attempt opens: its task when it belongs to the board Score follows now, otherwise the read-only attempt
 * page. Never a Watch URL: an attempt records no session to replay.
 */
export function attemptPath(attempt: Pick<AttemptSummary, 'id' | 'task'>): string {
  return `/b/attempts/${encodeURIComponent(attempt.id)}`
}

/** How the end of an attempt reads: an end time, a "no longer observed" boundary, or still running. */
export function attemptEndText(
  attempt: Pick<AttemptSummary, 'endedAt' | 'observationEndedAt'>,
  format: (iso: string) => string,
): string {
  if (attempt.endedAt) return `ended ${format(attempt.endedAt)}`
  if (attempt.observationEndedAt)
    return `no longer seen since ${format(attempt.observationEndedAt)}`
  return 'still running'
}
