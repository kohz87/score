import type { HermesAttempt, HermesEvidenceEvent, HermesTaskRow } from './types.ts'

export type Classification =
  | { evidence: 'proven'; basis: string }
  | { evidence: 'partial'; basis: string }
  | { evidence: 'synthetic'; basis: string }

/** What Score already stored for this attempt: frozen evidence and whether it was ever seen open. */
export interface StoredEvidence {
  evidence: 'proven' | 'partial'
  firstSeenOpen: boolean
  claimLock: string | null
  claimEventId: number | null
  workerPid: number | null
  workerStartedAt: string | null
}

export interface ClassifyInput {
  row: HermesAttempt
  stored: StoredEvidence | null
  events: readonly HermesEvidenceEvent[]
  eventsTruncated: boolean
  task: HermesTaskRow | undefined
}

// Outcomes Hermes's `_synthesize_ended_run` is called with, and the event each transition writes with the new
// run's id (`edit_task` records its synthesized completion as `edited`).
const SYNTHETIC_TRANSITIONS: Record<string, readonly string[]> = {
  completed: ['completed', 'edited'],
  blocked: ['blocked'],
  scheduled: ['scheduled'],
  review_requested: ['review_requested'],
}

/** Positive evidence that a worker was claimed or started. Persisted when first seen, never erased by cleanup. */
export function positiveEvidence(input: ClassifyInput): string | null {
  const { row, stored, events } = input
  if (row.claim_lock !== null || stored?.claimLock) return 'claim_lock'
  if (stored?.claimEventId != null) return 'claim_event'
  if (events.some((event) => event.kind === 'claimed' && event.run_id === row.id)) return 'claim_event'
  if (row.worker_pid !== null || stored?.workerPid != null) return 'worker_pid'
  if (row.worker_started_at !== null || stored?.workerStartedAt != null) return 'worker_started_at'
  if (
    events.some(
      (event) =>
        event.run_id === row.id && (event.kind === 'spawned' || event.kind === 'worker_registered'),
    )
  )
    return 'spawn_event'
  return null
}

/**
 * Proven: any positive evidence. Synthetic: only where the evidence distinguishes Hermes's synthetic writer from a
 * legacy backfill row (which is byte-identical when closed in the same second): first seen already closed, no
 * positive evidence, the synthetic shape, the synthesizing transition event under this run id, retained history
 * from the task's creation without any earlier claim, and a task that had not started before the row. Everything
 * else without evidence is partial, and a row ever seen open is never reclassified.
 */
export function classify(input: ClassifyInput): Classification {
  const proven = positiveEvidence(input)
  if (proven) return { evidence: 'proven', basis: proven }
  const { row, stored, events } = input
  if (stored) return { evidence: 'partial', basis: stored.firstSeenOpen ? 'seen_open' : 'carried_partial' }
  if (row.ended_at === null) return { evidence: 'partial', basis: 'open_without_evidence' }
  const partial = (basis: string): Classification => ({ evidence: 'partial', basis })
  if (row.started_at !== row.ended_at) return partial('closed_not_synthetic_shape')
  const transitions = row.outcome === null ? undefined : SYNTHETIC_TRANSITIONS[row.outcome]
  if (!transitions) return partial('closed_outcome_not_synthesized')
  if (input.eventsTruncated) return partial('events_truncated')
  if (!input.task) return partial('task_missing')
  if (input.task.started_at !== null && input.task.started_at <= row.started_at)
    return partial('task_started_before_row')
  if (!events.some((event) => event.kind === 'created' && event.task_id === row.task_id))
    return partial('history_not_retained')
  const transition = events.find((event) => event.run_id === row.id && transitions.includes(event.kind))
  if (!transition) return partial('transition_event_missing')
  const earlierClaim = events.some(
    (event) =>
      event.task_id === row.task_id &&
      ['claimed', 'spawned', 'worker_registered'].includes(event.kind) &&
      event.id < transition.id,
  )
  if (earlierClaim) return partial('claim_precedes_row')
  return { evidence: 'synthetic', basis: 'synthetic_transition' }
}
