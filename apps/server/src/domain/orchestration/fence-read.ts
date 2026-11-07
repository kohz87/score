import type { DatabaseSync } from 'node:sqlite'
import { type FenceItem, type GlobalFence } from '@score/contract'
import { z } from 'zod'
import type { ExecutionJournal } from './journal.ts'
import { GlobalRowSchema, ItemRowSchema } from './fence-types.ts'

export function readGlobal(sqlite: DatabaseSync) {
  return GlobalRowSchema.parse(sqlite.prepare('SELECT * FROM orc_global WHERE id = 1').get())
}

export function isFenced(sqlite: DatabaseSync): boolean {
  return readGlobal(sqlite).fenced === 1
}

export function fenceItems(sqlite: DatabaseSync): FenceItem[] {
  const seq = readGlobal(sqlite).fence_seq
  return z
    .array(ItemRowSchema)
    .parse(
      sqlite
        .prepare(
          'SELECT kind, ref, journal_n, detail FROM orc_fence_items WHERE fence_seq = ? ORDER BY id',
        )
        .all(seq),
    )
    .map((row) => ({
      kind: z
        .enum(['attempt', 'handle', 'fence', 'journal', 'restore'])
        .catch('journal')
        .parse(row.kind),
      ref: row.ref,
      detail: row.detail,
    }))
}

export function fenceView(sqlite: DatabaseSync, journal: ExecutionJournal): GlobalFence {
  const row = readGlobal(sqlite)
  const read = journal.readOwn()
  return {
    fenced: row.fenced === 1,
    reason: row.reason,
    untrustedHistory: row.untrusted_history === 1,
    revision: row.revision,
    since: row.since,
    items: row.fenced === 1 ? fenceItems(sqlite) : [],
    journal: {
      ok: read.ok,
      entries: read.ok ? read.entries.length : 0,
      bytes: read.bytes,
      sizeAlarm: journal.sizeAlarm(),
    },
  }
}
