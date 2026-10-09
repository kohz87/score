import type { HermesAttempt, Marks } from './types.ts'

/** What Score saved for a history, and the immutable tuple of each attempt it knows. */
export interface SavedHistory {
  eventMark: number
  attemptMark: number
  fileIdentity: string | null
}

export interface KnownAttempt {
  attemptId: number
  taskId: string
  startedAt: number
  closed: boolean
  /** Frozen evidence: first non-null value seen. */
  claimLock: string | null
  profile: string | null
  workerPid: number | null
  workerStartedAt: string | null
}

export type Verdict =
  | { verdict: 'ok'; eventMark: number; attemptMark: number }
  | { verdict: 'contradiction'; reason: string }
  | { verdict: 'insufficient'; reason: string }

type EffectiveMark = { mark: number } | { insufficient: string }

/**
 * Allocation mark of one table. A missing `sqlite_sequence` row is valid only while the table is empty (then 0); a
 * missing row with rows present, or a sequence below the highest retained id, cannot be explained by normal Hermes
 * writes and is insufficient evidence.
 */
export function effectiveMark(
  table: string,
  seq: number | null,
  min: number | null,
  max: number | null,
): EffectiveMark {
  if (seq === null) {
    return min === null && max === null
      ? { mark: 0 }
      : { insufficient: `${table} has rows but no sqlite_sequence row` }
  }
  if (max !== null && seq < max)
    return { insufficient: `${table} sqlite_sequence is below its highest id` }
  return { mark: seq }
}

function sameFingerprint(a: string | null, b: number | string | null): boolean {
  return a === null || b === null || a === String(b)
}

/** Frozen evidence is compared non-null to non-null only: clearing or enriching a field is not a contradiction. */
export function tupleContradiction(known: KnownAttempt, row: HermesAttempt): string | null {
  const id = `attempt ${known.attemptId}`
  if (known.taskId !== row.task_id) return `${id} now belongs to another task`
  if (known.startedAt !== row.started_at) return `${id} has a different start time`
  if (known.claimLock !== null && row.claim_lock !== null && known.claimLock !== row.claim_lock)
    return `${id} has a different claim lock`
  if (known.profile !== null && row.profile !== null && known.profile !== row.profile)
    return `${id} has a different claim profile`
  if (known.workerPid !== null && row.worker_pid !== null && known.workerPid !== row.worker_pid)
    return `${id} has a different worker pid`
  if (!sameFingerprint(known.workerStartedAt, row.worker_started_at))
    return `${id} has a different worker fingerprint`
  if (known.closed && row.ended_at === null) return `${id} was closed and is open again`
  return null
}

export interface JudgeInput {
  saved: SavedHistory
  observedIdentity: string
  marks: Marks | null
  rows: readonly HermesAttempt[]
  sample: readonly HermesAttempt[]
  /** Score's knowledge of the attempts in `rows` and `sample`, by attempt id. */
  known: ReadonlyMap<number, KnownAttempt>
  /** Total attempts Score knows in this history (decides whether an identity sample can say anything). */
  knownCount: number
  sampleIds: readonly number[]
}

/**
 * Normal maintenance (GC, deletions: retained maxima fall, allocation marks do not) keeps the history. A mark below
 * its own saved mark, a changed tuple or a terminal -> open regression is a contradiction; unreadable or
 * inconsistent sequences, or an identity change the sample cannot decide, are insufficient evidence. A restore that
 * preserves both saved marks and all checked frozen evidence is undetectable (documented, not promised away).
 */
export function judgeHistory(input: JudgeInput): Verdict {
  if (input.marks === null) return { verdict: 'insufficient', reason: 'sqlite_sequence unreadable' }
  const events = effectiveMark(
    'task_events',
    input.marks.eventSeq,
    input.marks.eventMin,
    input.marks.eventMax,
  )
  const runs = effectiveMark(
    'task_runs',
    input.marks.runSeq,
    input.marks.runMin,
    input.marks.runMax,
  )
  if ('insufficient' in events) return { verdict: 'insufficient', reason: events.insufficient }
  if ('insufficient' in runs) return { verdict: 'insufficient', reason: runs.insufficient }
  if (events.mark < input.saved.eventMark)
    return {
      verdict: 'contradiction',
      reason: 'task_events allocation mark fell below the saved mark',
    }
  if (runs.mark < input.saved.attemptMark)
    return {
      verdict: 'contradiction',
      reason: 'task_runs allocation mark fell below the saved mark',
    }
  for (const row of [...input.rows, ...input.sample]) {
    const known = input.known.get(row.id)
    const reason = known ? tupleContradiction(known, row) : null
    if (reason) return { verdict: 'contradiction', reason }
  }
  const identityChanged =
    input.saved.fileIdentity !== null && input.saved.fileIdentity !== input.observedIdentity
  if (
    identityChanged &&
    input.knownCount > 0 &&
    input.sampleIds.length > 0 &&
    input.sample.length === 0
  )
    return {
      verdict: 'insufficient',
      reason: 'database file changed and no known attempt could be checked',
    }
  return { verdict: 'ok', eventMark: events.mark, attemptMark: runs.mark }
}
