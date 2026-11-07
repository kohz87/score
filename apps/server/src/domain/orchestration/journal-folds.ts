import { CODING_RECORD_KINDS as CODING_KINDS } from './coding-records.ts'
import { journalDispatches } from './journal-dispatch.ts'
import type { JournalEntry } from './journal-entry.ts'

/**
 * v8.3: an attempt's older dispatch generations fold into at most one entry. If the latest generation was sent, its
 * `send_started` stays and the earlier pairs go; if it was refused, one `witness` takes the place of the whole group at
 * the number of its newest entry. The latest generation, its state and the numbering are preserved, so a restored
 * database that is behind the newest generation is still detected after compaction.
 */
export function foldGenerations(entries: readonly JournalEntry[], scope: string): JournalEntry[] {
  const byAttempt = new Map<string, JournalEntry[]>()
  for (const entry of entries) {
    if (entry.scope !== scope) continue
    if (
      entry.kind === 'send_started' ||
      entry.kind === 'send_refused' ||
      entry.kind === 'send_closed' ||
      entry.kind === 'witness'
    ) {
      const group = byAttempt.get(entry.attemptId) ?? []
      group.push(entry)
      byAttempt.set(entry.attemptId, group)
    }
  }
  const drop = new Set<number>()
  const replace = new Map<number, JournalEntry>()
  for (const group of byAttempt.values()) {
    if (group.length < 2) continue
    const latest = [...journalDispatches(group).values()][0]!
    const newest = group.at(-1)!
    if (latest.state === 'sent') {
      // Keep the latest send_started; everything older is superseded.
      const keep = group.findLast((e) => e.kind === 'send_started')!
      for (const e of group) if (e.n !== keep.n) drop.add(e.n)
    } else {
      const refused = group.reduce(
        (sum, e) =>
          sum + (e.kind === 'send_refused' ? 1 : e.kind === 'witness' ? e.refusedCount : 0),
        0,
      )
      for (const e of group) drop.add(e.n)
      drop.delete(newest.n)
      replace.set(newest.n, {
        n: newest.n,
        at: newest.at,
        scope: newest.scope,
        kind: 'witness',
        attemptId: (newest as { attemptId: string }).attemptId,
        orchestrationId: (newest as { orchestrationId: string }).orchestrationId,
        lastGeneration: latest.generation,
        lastState: latest.state === 'closed' ? 'closed' : 'refused',
        refusedCount: refused,
      })
    }
  }
  return entries.filter((e) => !drop.has(e.n)).map((e) => replace.get(e.n) ?? e)
}

/**
 * 7.7a §2: only a launch's newest coding record survives compaction, and a settled launch's becomes a compact tombstone
 * kept forever (same number). The newest record carries the launch's full state, including the monotonic "may have
 * executed" and "revoked" flags, so nothing a restore check needs is lost; an unsettled launch keeps its real record.
 */
export function foldCodingRecords(entries: readonly JournalEntry[], scope: string): JournalEntry[] {
  const newest = new Map<string, number>()
  for (const entry of entries) {
    if (entry.scope !== scope) continue
    const launchId = (entry as { launchId?: string }).launchId
    if (launchId !== undefined && isCodingKind(entry.kind)) newest.set(launchId, entry.n)
  }
  const out: JournalEntry[] = []
  for (const entry of entries) {
    const launchId = (entry as { launchId?: string }).launchId
    if (entry.scope !== scope || launchId === undefined || !isCodingKind(entry.kind)) {
      out.push(entry)
      continue
    }
    if (newest.get(launchId) !== entry.n) continue
    if (entry.kind === 'settled' || entry.kind === 'waived') {
      out.push({ ...entry, kind: 'coding-tombstone', of: entry.kind } as JournalEntry)
    } else out.push(entry)
  }
  return out
}

function isCodingKind(kind: string): boolean {
  return kind === 'coding-tombstone' || (CODING_KINDS as readonly string[]).includes(kind)
}
