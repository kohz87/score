import { z } from 'zod'
import type { MediaStore } from '../media/store.ts'
import type { ScoreDb } from '../db/index.ts'
import { mediaIdOf } from '../domain/watch-frames.ts'
import { heldIngestPositions } from './ingest.ts'

export function retireMedia(media: MediaStore): {
  removed: number
  missing: number
  orphans: number
} {
  return media.sweep()
}

export const INTERNAL_OBSERVATION_SOURCES = [
  'approval-sweep',
  'approval-expiry',
  'approval-outbox',
  'approval-decision',
  'kanban-denial-sweep',
  'task-actions',
  'rooms',
  'task-holds',
  'agent-pause',
  'briefs',
  'team',
  'agents',
  'orchestration',
  'fake',
] as const

const IDLE_SCOPE_MS = 30 * 24 * 60 * 60 * 1000

const OptionsSchema = z.object({
  keepPositions: z.int().nonnegative(),
  batchSize: z.int().positive(),
})
const CheckpointRowSchema = z.object({
  source: z.string().min(1),
  scope: z.string().min(1),
  cursor: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().nonnegative()),
  incarnation: z.string().nullable(),
  updated_at: z.string(),
  floor: z.int().nonnegative().nullable(),
})

// Frames that showed an image release their media reference as they are deleted.
function releaseAndDeleteOldFrames(db: ScoreDb, cutoff: string): void {
  db.tx((sqlite) => {
    const old = `at <= ? AND seq < (
         SELECT MAX(newer.seq) FROM watch_frames newer WHERE newer.agent_id = watch_frames.agent_id)`
    const rows = z
      .array(z.object({ payload: z.string() }))
      .parse(
        sqlite
          .prepare(`SELECT payload FROM watch_frames WHERE surface = 'browser' AND ${old}`)
          .all(cutoff),
      )
    for (const { payload } of rows) {
      const id = mediaIdOf((JSON.parse(payload) as { imageUrl?: string | null }).imageUrl)
      if (id) sqlite.prepare('UPDATE media SET refs = MAX(refs - 1, 0) WHERE id = ?').run(id)
    }
    sqlite.prepare(`DELETE FROM watch_frames WHERE ${old}`).run(cutoff)
  })
}

export function retireIngestKeys(
  db: ScoreDb,
  {
    keepPositions = 10_000,
    batchSize = 5_000,
    now = Date.now(),
  }: { keepPositions?: number; batchSize?: number; now?: number } = {},
): { retired: number; floors: number } {
  const options = OptionsSchema.parse({ keepPositions, batchSize })
  const checkpoints = z.array(CheckpointRowSchema).parse(
    db.sqlite
      .prepare(
        `SELECT c.source, c.scope, c.cursor, c.incarnation, c.updated_at, f.floor
         FROM ingest_checkpoints c LEFT JOIN ingest_floors f
           ON f.source = c.source AND f.scope = c.scope
           AND f.incarnation = COALESCE(c.incarnation, '')
         WHERE c.scope NOT LIKE 'gap:%'`,
      )
      .all(),
  )
  const cutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  let retired = db.tx((sqlite) =>
    Number(
      sqlite
        .prepare(
          `DELETE FROM ingest_keys WHERE source IN (${INTERNAL_OBSERVATION_SOURCES.map(() => '?').join(',')}) AND created_at <= ?`,
        )
        .run(...INTERNAL_OBSERVATION_SOURCES, cutoff).changes,
    ),
  )
  retired += reclaimCodingEventKeys(db, options.batchSize)
  // Watch frames live 7 days (D6), but each agent keeps its newest frame so per-agent `seq` never restarts.
  releaseAndDeleteOldFrames(db, new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString())
  db.sqlite
    .prepare('DELETE FROM request_receipts WHERE created_at <= ? AND status IS NOT NULL')
    .run(cutoff)
  // Gap scopes are temporary coverage ranges, not key streams; a floor would outlive their consumption.
  let floors = 0
  for (const checkpoint of checkpoints) {
    // A scope untouched this long has finished: nothing will be redelivered, and the floor still rejects it if so.
    const idle = Date.parse(checkpoint.updated_at) <= now - IDLE_SCOPE_MS
    let target = checkpoint.cursor - (idle ? 0 : options.keepPositions)
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

/**
 * Retention contract for `coding:<agent>` ingest keys. A run's detailed event keys (`coding:<run>:running` and
 * `coding:<run>:<index>`) are only needed while the run can still change. They go once the run is terminal (or
 * already pruned), its result is delivered (no `coding_pending_terminals` row) and its launch is settled (or it never
 * had one). The `admitted:*` and `coding:<run>:terminal` keys stay as the bounded per-run replay guard, and a replayed
 * event or running observation against a terminal run applies nothing anyway. Pending and unsettled runs keep
 * everything; there is no time-based expiry.
 */
export function reclaimCodingEventKeys(db: ScoreDb, batchSize: number): number {
  let total = 0
  let changes: number
  do {
    changes = db.tx((sqlite) =>
      Number(
        sqlite
          .prepare(
            `WITH detail AS (
               SELECT rowid AS rid,
                      substr(identity, 8, instr(substr(identity, 8), ':') - 1) AS run_id,
                      substr(identity, 8 + instr(substr(identity, 8), ':')) AS tail
               FROM ingest_keys
               WHERE source LIKE 'coding:%' AND identity LIKE 'coding:%' AND instr(substr(identity, 8), ':') > 0
             )
             DELETE FROM ingest_keys WHERE rowid IN (
               SELECT d.rid FROM detail d
               WHERE (d.tail = 'running' OR (d.tail <> '' AND d.tail NOT GLOB '*[^0-9]*'))
                 AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = d.run_id
                                 AND r.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted'))
                 AND NOT EXISTS (SELECT 1 FROM coding_pending_terminals t WHERE t.run_id = d.run_id)
                 AND NOT EXISTS (SELECT 1 FROM coding_launches l WHERE l.run_id = d.run_id AND l.phase <> 'settled')
               LIMIT ?
             )`,
          )
          .run(batchSize).changes,
      ),
    )
    total += changes
  } while (changes === batchSize)
  return total
}
