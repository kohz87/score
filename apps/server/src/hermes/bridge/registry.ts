import { BridgeHelloRequestSchema, type SystemStatus } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export const ProducerSchema = z.object({
  id: z.string(),
  profile: z.string(),
  incarnation: z.string(),
  pid: z.int().positive(),
  kanban_task_id: z.string().nullable(),
  isolation: BridgeHelloRequestSchema.shape.isolation,
  token_hash: z.string().regex(/^[a-f0-9]{64}$/),
  token_expires_at: z.int(),
  acked_through: z.int().nonnegative(),
})
export type Producer = z.infer<typeof ProducerSchema>

const PositionSchema = z.object({ first: z.int().positive(), last: z.int().positive() })

export function acknowledge(sqlite: DatabaseSync, producer: Producer, at: string): number {
  const { acked_through: previous } = ProducerSchema.parse(
    sqlite.prepare('SELECT * FROM producers WHERE id = ?').get(producer.id),
  )
  const source = `bridge:${producer.incarnation}`
  // Gap ranges use numeric checkpoints too, so a large loss never needs one row per lost event.
  const ranges = z.array(PositionSchema).parse(
    sqlite
      .prepare(
        `SELECT position AS first, position AS last FROM ingest_keys
     WHERE source = ? AND scope = 'events' AND position > ?
     UNION ALL
     SELECT CAST(substr(scope, 5) AS INTEGER) AS first, CAST(cursor AS INTEGER) AS last
     FROM ingest_checkpoints WHERE source = ? AND scope LIKE 'gap:%'
     ORDER BY first`,
      )
      .all(source, previous, source),
  )
  let ack = previous
  for (const range of ranges) {
    if (range.first > ack + 1) break
    ack = Math.max(ack, range.last)
  }
  sqlite
    .prepare('UPDATE producers SET acked_through = ?, last_seen_at = ? WHERE id = ?')
    .run(ack, at, producer.id)
  // Ingest normally records the highest observed position; bridge retirement must stop at holes.
  sqlite
    .prepare(
      `INSERT INTO ingest_checkpoints (source, scope, cursor, incarnation, updated_at)
       VALUES (?, 'events', ?, ?, ?) ON CONFLICT (source, scope) DO UPDATE SET
       cursor = excluded.cursor, updated_at = excluded.updated_at`,
    )
    .run(source, String(ack), producer.incarnation, at)
  sqlite
    .prepare(
      `DELETE FROM ingest_checkpoints WHERE source = ? AND scope LIKE 'gap:%' AND CAST(cursor AS INTEGER) <= ?`,
    )
    .run(source, ack)
  return ack
}

export function getBridgeStatus(sqlite: DatabaseSync, now = Date.now()): SystemStatus['bridge'] {
  const { producers } = z
    .object({ producers: z.int().nonnegative() })
    .parse(
      sqlite
        .prepare('SELECT count(*) AS producers FROM producers WHERE last_seen_at >= ?')
        .get(new Date(now - 5 * 60 * 1000).toISOString()),
    )
  const row = sqlite
    .prepare(
      'SELECT last_seen_at, isolation FROM producers ORDER BY last_seen_at DESC, rowid DESC LIMIT 1',
    )
    .get()
  const latest =
    row === undefined
      ? undefined
      : z
          .object({
            last_seen_at: z.iso.datetime(),
            isolation: BridgeHelloRequestSchema.shape.isolation,
          })
          .parse(row)
  return {
    producers,
    lastSeenAt: latest?.last_seen_at ?? null,
    isolation: latest?.isolation ?? 'unknown',
  }
}
