import type { JournalEntry } from './journal-entry.ts'
import { foldCodingRecords, foldGenerations } from './journal-folds.ts'

export interface CompactionEntries {
  entries: JournalEntry[]
  dropped: number
  changed: boolean
}

export function compactEntries(
  entries: readonly JournalEntry[],
  scope: string,
  droppable: (entry: JournalEntry) => boolean,
): CompactionEntries {
  // Detail goes, the proof stays: an admission or a fence becomes a permanent tombstone with its original number.
  const out: JournalEntry[] = []
  const folded = foldCodingRecords(foldGenerations(entries, scope), scope)
  for (const entry of folded) {
    const compactable = [
      'send_started',
      'run_handle',
      'reconciled',
      'stop_fence',
      'transition',
      'authorization',
      'hold',
      'remap',
      'renewal',
      'send_refused',
      'witness',
    ].includes(entry.kind)
    if (entry.scope !== scope || !compactable || !droppable(entry)) {
      out.push(entry)
    } else if (entry.kind === 'send_started') {
      out.push({
        n: entry.n,
        at: entry.at,
        scope: entry.scope,
        kind: 'tombstone',
        of: 'send_started',
        orchestrationId: entry.orchestrationId,
        attemptId: entry.attemptId,
        generation: entry.generation,
      })
    } else if (
      entry.kind === 'witness' ||
      entry.kind === 'send_refused' ||
      entry.kind === 'send_closed'
    ) {
      // The database keeps the attempt's dispatch_generation, so the journal must keep a word on it (A1).
      out.push({
        n: entry.n,
        at: entry.at,
        scope: entry.scope,
        kind: 'tombstone',
        of: 'witness',
        orchestrationId: entry.orchestrationId,
        attemptId: entry.attemptId,
        generation: entry.kind === 'witness' ? entry.lastGeneration : entry.generation,
        lastState:
          entry.kind === 'witness'
            ? entry.lastState
            : entry.kind === 'send_closed'
              ? 'closed'
              : 'refused',
      })
    } else if (entry.kind === 'stop_fence') {
      out.push({
        n: entry.n,
        at: entry.at,
        scope: entry.scope,
        kind: 'tombstone',
        of: 'stop_fence',
        orchestrationId: entry.orchestrationId,
        ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
      })
    } else if (entry.kind === 'transition') {
      out.push({
        n: entry.n,
        at: entry.at,
        scope: entry.scope,
        kind: 'tombstone',
        of: 'transition',
        orchestrationId: entry.orchestrationId,
        what: entry.what,
        ...(entry.attemptIds ? { attemptIds: entry.attemptIds } : {}),
      })
    }
    // run_handle, reconciled, authorization and hold entries carry nothing a tombstone would keep (the caller only
    // marks them droppable once superseded or settled).
  }
  // Folded generation entries and the checkpoint below keep the sequence monotonic.
  const last = entries.at(-1)
  if (last && out.at(-1)?.n !== last.n)
    out.push({ n: last.n, at: last.at, scope: last.scope, kind: 'checkpoint' })
  const dropped = entries.length - out.length
  const changed = JSON.stringify(out) !== JSON.stringify(entries)
  return { entries: out, dropped, changed }
}
