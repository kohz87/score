import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { heldIngestPositions } from './ingest.ts'

const OptionsSchema = z.object({
  keepPositions: z.int().nonnegative(),
  batchSize: z.int().positive(),
})
const CheckpointRowSchema = z.object({
  source: z.string().min(1),
  scope: z.string().min(1),
  cursor: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().nonnegative()),
  incarnation: z.string().nullable(),
  floor: z.int().nonnegative().nullable(),
})

export function retireIngestKeys(
  db: ScoreDb,
  {
    keepPositions = 10_000,
    batchSize = 5_000,
  }: { keepPositions?: number; batchSize?: number } = {},
): { retired: number; floors: number } {
  const options = OptionsSchema.parse({ keepPositions, batchSize })
  const checkpoints = z.array(CheckpointRowSchema).parse(
    db.sqlite
      .prepare(
        `SELECT c.source, c.scope, c.cursor, c.incarnation, f.floor
         FROM ingest_checkpoints c LEFT JOIN ingest_floors f
           ON f.source = c.source AND f.scope = c.scope
           AND f.incarnation = COALESCE(c.incarnation, '')
         WHERE c.scope NOT LIKE 'gap:%'`,
      )
      .all(),
  )
  let retired = 0
  // Gap scopes are temporary coverage ranges, not key streams; a floor would outlive their consumption.
  let floors = 0
  for (const checkpoint of checkpoints) {
    let target = checkpoint.cursor - options.keepPositions
    for (const position of heldIngestPositions(db, checkpoint.source, checkpoint.scope)) {
      target = Math.min(target, position - 1)
    }
    // Floor first: it rejects every position <= floor whether or not the keys still exist, so the
    // deletes below are pure cleanup and an interruption between batches can't let a duplicate in.
    const current = checkpoint.floor ?? -1
    if (target > current) {
      floors += db.tx((sqlite) =>
        Number(
          sqlite
            .prepare(
              `INSERT INTO ingest_floors (source, scope, incarnation, floor, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (source, scope, incarnation) DO UPDATE SET
                 floor = excluded.floor, updated_at = excluded.updated_at
               WHERE excluded.floor > ingest_floors.floor`,
            )
            .run(
              checkpoint.source,
              checkpoint.scope,
              checkpoint.incarnation ?? '',
              target,
              new Date().toISOString(),
            ).changes,
        ),
      )
    }
    // Always clean up to the effective floor, so a run interrupted after the floor write finishes later.
    const floor = Math.max(current, target)
    if (floor < 0) continue
    let changes: number
    do {
      changes = db.tx((sqlite) =>
        Number(
          sqlite
            .prepare(
              `DELETE FROM ingest_keys WHERE rowid IN (
                SELECT rowid FROM ingest_keys
                WHERE source = ? AND scope = ? AND incarnation IS ? AND position <= ?
                ORDER BY position LIMIT ?
              )`,
            )
            .run(
              checkpoint.source,
              checkpoint.scope,
              checkpoint.incarnation,
              floor,
              options.batchSize,
            ).changes,
        ),
      )
      retired += changes
    } while (changes === options.batchSize)
  }
  return { retired, floors }
}
