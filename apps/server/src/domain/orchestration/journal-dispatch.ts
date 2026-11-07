import type { JournalEntry } from './journal-entry.ts'

/** What the journal says about an attempt's dispatch: its latest generation and whether that one was sent. */
export interface JournalDispatch {
  generation: number
  state: 'sent' | 'refused' | 'closed'
  n: number
}

/** The journal's latest word on every attempt that has a `send_started` (or its tombstone, or a witness). */
export function journalDispatches(entries: readonly JournalEntry[]): Map<string, JournalDispatch> {
  const result = new Map<string, JournalDispatch>()
  for (const entry of entries) {
    if (entry.kind === 'send_started')
      result.set(entry.attemptId, { generation: entry.generation, state: 'sent', n: entry.n })
    else if (entry.kind === 'send_refused') {
      const current = result.get(entry.attemptId)
      if (!current || current.generation <= entry.generation)
        result.set(entry.attemptId, { generation: entry.generation, state: 'refused', n: entry.n })
    } else if (entry.kind === 'send_closed') {
      const current = result.get(entry.attemptId)
      if (!current || current.generation <= entry.generation)
        result.set(entry.attemptId, { generation: entry.generation, state: 'closed', n: entry.n })
    } else if (entry.kind === 'witness')
      result.set(entry.attemptId, {
        generation: entry.lastGeneration,
        state: entry.lastState,
        n: entry.n,
      })
    else if (entry.kind === 'tombstone' && entry.of === 'send_started' && entry.attemptId)
      result.set(entry.attemptId, { generation: entry.generation ?? 0, state: 'sent', n: entry.n })
    else if (entry.kind === 'tombstone' && entry.of === 'witness' && entry.attemptId)
      result.set(entry.attemptId, {
        generation: entry.generation ?? 0,
        state: entry.lastState ?? 'refused',
        n: entry.n,
      })
  }
  return result
}
