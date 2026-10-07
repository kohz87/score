import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'

export function pruneBridge(
  db: ScoreDb,
  { now = Date.now() }: { now?: number } = {},
): { producers: number; approvalSignals: number } {
  const cutoff = new Date(z.int().parse(now) - 30 * 24 * 60 * 60 * 1000).toISOString()
  return db.tx((sqlite) => {
    // Keep inactive producers while their durable backlog or disconnected gap ranges remain open.
    const producers = Number(
      sqlite
        .prepare(
          `
      DELETE FROM producers WHERE last_seen_at < ?
        AND NOT EXISTS (SELECT 1 FROM approval_deliveries d WHERE d.producer_id = producers.id AND d.state IN ('intent','delivering'))
        AND NOT EXISTS (SELECT 1 FROM ingest_keys k WHERE k.source = 'bridge:' || producers.incarnation
          AND (k.position IS NULL OR k.position > producers.acked_through))
        AND NOT EXISTS (SELECT 1 FROM ingest_checkpoints c
          WHERE c.source = 'bridge:' || producers.incarnation AND c.scope LIKE 'gap:%')
    `,
        )
        .run(cutoff).changes,
    )
    const expired = Number(
      sqlite.prepare('DELETE FROM approval_signals WHERE at < ?').run(cutoff).changes,
    )
    const excess = Number(
      sqlite
        .prepare(
          `
      DELETE FROM approval_signals WHERE id IN (
        SELECT id FROM approval_signals WHERE matched_approval_id IS NOT NULL OR at < ? ORDER BY at DESC, id DESC LIMIT -1 OFFSET 50000
      )
    `,
        )
        .run(new Date(now - 24 * 60 * 60 * 1000).toISOString()).changes,
    )
    return { producers, approvalSignals: expired + excess }
  })
}
