import type { AttemptStatus, AttemptSummary } from '@score/contract'

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

/**
 * Where an attempt opens: its task when it belongs to the board Score follows now, otherwise the read-only attempt
 * page. Never a Watch URL: an attempt records no session to replay.
 */
export function attemptPath(attempt: Pick<AttemptSummary, 'id' | 'task'>): string {
  return `/b/attempts/${encodeURIComponent(attempt.id)}`
}
