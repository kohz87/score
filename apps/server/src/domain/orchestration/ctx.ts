import type { DatabaseSync } from 'node:sqlite'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import type { ExecutionJournal } from './journal.ts'

/** What one executor transaction carries: the connection, the time, the runs it touched and the events it produced. */
export interface Ctx {
  sqlite: DatabaseSync
  now: string
  journal: ExecutionJournal
  touched: Set<string>
  events: DomainEventDraft[]
  /** Set when a journal write failed inside the transaction: the caller fences after the commit. */
  journalFailure?: string
}

export const touch = (ctx: Ctx, orchId: string): void => {
  ctx.touched.add(orchId)
}

/** Appends to the journal; a failure is recorded on the context (and the run fenced) instead of aborting a Stop. */
export function journalSoft(ctx: Ctx, write: () => void): void {
  try {
    write()
  } catch (error) {
    ctx.journalFailure = error instanceof Error ? error.message : String(error)
  }
}
