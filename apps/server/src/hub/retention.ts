import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'

const OptionsSchema = z.object({
  olderThan: z.iso.datetime(),
  batchSize: z.int().positive(),
})
const readers = new WeakMap<ScoreDb, Set<{ cursor: number }>>()

// Paged replay yields to writers. Protect its unread rows from the hourly prune until release.
export function retainEvents(db: ScoreDb) {
  const active = readers.get(db) ?? new Set<{ cursor: number }>()
  readers.set(db, active)
  const reader = { cursor: 0 }
  active.add(reader)
  return {
    advance(cursor: number): void {
      reader.cursor = cursor
    },
    release(): void {
      if (!active.delete(reader)) return
      if (active.size === 0) readers.delete(db)
    },
  }
}

export function pruneEvents(
  db: ScoreDb,
  {
    olderThan = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    batchSize = 5000,
  }: { olderThan?: string; batchSize?: number } = {},
): number {
  const options = OptionsSchema.parse({ olderThan, batchSize })
  const active = readers.get(db)
  const maxSeq = active?.size
    ? Math.min(...Array.from(active, (reader) => reader.cursor))
    : Number.MAX_SAFE_INTEGER
  let deleted = 0
  let changes: number
  do {
    changes = db.tx((sqlite) =>
      Number(
        sqlite
          .prepare(
            `DELETE FROM events WHERE seq IN (
              SELECT seq FROM events WHERE ts < ? AND seq <= ? ORDER BY seq LIMIT ?
            )`,
          )
          .run(options.olderThan, maxSeq, options.batchSize).changes,
      ),
    )
    deleted += changes
  } while (changes === options.batchSize)
  return deleted
}
