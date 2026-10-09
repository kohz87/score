import { createHash } from 'node:crypto'
import { z } from 'zod'
import { redactBounded } from '../../../redact.ts'
import type { HermesAttempt, HermesEvidenceEvent, HermesTaskRow } from './types.ts'

export const ATTEMPT_STATUSES = [
  'running',
  'completed',
  'failed',
  'blocked',
  'review_handoff',
  'changes_requested',
  'ended_unknown',
] as const
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number]

// Hermes outcomes (kanban_db.py `_end_run` callers). Anything not listed is "other", never guessed.
const OUTCOME_STATUS: Record<string, AttemptStatus> = {
  completed: 'completed',
  review_requested: 'review_handoff',
  changes_requested: 'changes_requested',
  blocked: 'blocked',
  dependency_wait: 'blocked',
  crashed: 'failed',
  timed_out: 'failed',
  spawn_failed: 'failed',
  gave_up: 'failed',
  stale: 'failed',
  failed: 'failed',
  // The attempt ended, but how the work went is not stated.
  reclaimed: 'ended_unknown',
  scheduled: 'ended_unknown',
  released: 'ended_unknown',
}
// `status` column fallback when a closed row has no outcome.
const STATUS_FALLBACK: Record<string, AttemptStatus> = {
  done: 'completed',
  blocked: 'blocked',
  crashed: 'failed',
  timed_out: 'failed',
  failed: 'failed',
}

export function attemptStatus(row: HermesAttempt): {
  status: AttemptStatus
  closureReason: string | null
} {
  if (row.ended_at === null) return { status: 'running', closureReason: null }
  if (row.outcome !== null) {
    const known = OUTCOME_STATUS[row.outcome]
    return { status: known ?? 'ended_unknown', closureReason: known ? row.outcome : 'other' }
  }
  const fallback = STATUS_FALLBACK[row.status]
  return { status: fallback ?? 'ended_unknown', closureReason: 'unknown' }
}

export function isTerminal(status: AttemptStatus): boolean {
  return status !== 'running'
}

export const SUMMARY_BYTES = 8 * 1024
export const ERROR_BYTES = 2 * 1024
export const TITLE_CHARS = 300
export const SNAPSHOT_BYTES = 4 * 1024

export function boundedText(text: string | null, bytes: number): string | null {
  return text === null ? null : redactBounded(text, bytes)
}

export function taskSnapshot(task: HermesTaskRow | undefined): string | null {
  if (!task) return null
  const value = {
    title: redactBounded(task.title, TITLE_CHARS * 4).slice(0, TITLE_CHARS),
    status: task.status.slice(0, 40),
    assignee: task.assignee === null ? null : task.assignee.slice(0, 100),
  }
  const json = JSON.stringify(value)
  return Buffer.byteLength(json) <= SNAPSHOT_BYTES ? json : null
}

const ClaimPayload = z.object({ source_status: z.string().optional(), run_id: z.int().optional() })

export interface ClaimEvidence {
  eventId: number
  sourceStatus: string | null
}

/** The oldest retained `claimed` event of one attempt. */
export function claimEventFor(
  events: readonly HermesEvidenceEvent[],
  attemptId: number,
): ClaimEvidence | null {
  for (const event of events) {
    if (event.kind !== 'claimed') continue
    let payload: z.infer<typeof ClaimPayload> = {}
    try {
      const parsed = ClaimPayload.safeParse(JSON.parse(event.payload ?? 'null'))
      if (parsed.success) payload = parsed.data
    } catch {
      // Malformed payload: the event still proves a claim happened, only its source status is unknown.
    }
    if (event.run_id !== attemptId && payload.run_id !== attemptId) continue
    return { eventId: event.id, sourceStatus: payload.source_status ?? null }
  }
  return null
}

export function fingerprintOf(value: number | string | null): string | null {
  return value === null ? null : String(value)
}

export function hashContent(content: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}
