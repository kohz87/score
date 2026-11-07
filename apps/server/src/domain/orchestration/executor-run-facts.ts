import type { DatabaseSync } from 'node:sqlite'
import type { AttemptRow } from './store.ts'

export interface RunFacts {
  status: string
  output: string | null
  error: string | null
  ended_at: string | null
  terminal_source: string | null
}

/** Only a runtime's own, confirmed terminal word is evidence; text rebuilt from history, or a run whose process group was never proven gone, is not (fix-h item 1, fix-w). */
export const isEvidence = (run: RunFacts): boolean =>
  (run.status === 'completed' || run.status === 'failed') &&
  run.terminal_source !== 'recovered' &&
  run.terminal_source !== 'unconfirmed'

/** A step attempt given to a coding worker (its launches are supervised units, its result is the eligible reply). */
export const isCodingStep = (attempt: Pick<AttemptRow, 'kind' | 'runtime'>): boolean =>
  attempt.kind === 'step' && attempt.runtime !== 'hermes'

/** The launch of the attempt's current generation has end proof in the database projection (a cheap read). */
export function codingProofIn(sqlite: DatabaseSync, attempt: AttemptRow): boolean {
  const row = sqlite
    .prepare(
      `SELECT 1 FROM coding_launches l JOIN orc_generations g ON g.launch_id = l.launch_id
       WHERE g.attempt_id = ? AND g.generation = ? AND l.phase IN ('ended', 'settled') AND l.proof IS NOT NULL AND l.waiver = 0`,
    )
    .get(attempt.id, attempt.dispatch_generation)
  return row !== undefined
}
