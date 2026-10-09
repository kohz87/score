import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ScoreDb } from '../../../db/index.ts'
import { rewriteReceipts } from '../../../domain/legacy-links.ts'
import type { ObservationSink } from '../../port.ts'

// Legacy numeric run links (task_projections.detail.runIds) from before attempts had their own identity. The inputs
// are snapshotted once; mapping then needs affirmative proof (design v5 §E as narrowed by v5.1 #1), everything else
// stays unresolved. Receipts and response shapes are stage 2.

const ProjectionSchema = z.object({
  runIds: z.array(z.string()).default([]),
  activity: z
    .array(z.object({ at: z.string(), agentId: z.string().nullable(), text: z.string() }))
    .default([]),
})
const SavedEvidenceSchema = z.object({
  claims: z.array(z.object({ at: z.string(), agentId: z.string().nullable() })),
})
const LinkRowSchema = z.object({
  task_id: z.string(),
  legacy_id: z.string(),
  saved_evidence: z.string(),
})
const AttemptProofSchema = z.object({
  id: z.string(),
  profile: z.string().nullable(),
  started_at: z.int(),
})

export const UPGRADE_BATCH = 100

/** One-time snapshot of the legacy links, before any reconciliation can rewrite the projections. */
export async function snapshotUpgradeLinks(
  db: ScoreDb,
  sink: ObservationSink,
  source: string,
): Promise<void> {
  if (db.sqlite.prepare('SELECT 1 FROM kanban_upgrade_state WHERE id = 1').get()) return
  await sink.submit({
    source,
    identity: 'kanban:upgrade-snapshot',
    apply: ({ sqlite, now }) => {
      if (sqlite.prepare('SELECT 1 FROM kanban_upgrade_state WHERE id = 1').get()) return []
      const insert = sqlite.prepare(
        `INSERT INTO kanban_upgrade_links (task_id, legacy_id, saved_evidence, snapshotted_at)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      for (const raw of sqlite.prepare('SELECT id, detail FROM task_projections').all()) {
        const row = z.object({ id: z.string(), detail: z.string() }).parse(raw)
        let detail: unknown
        try {
          detail = JSON.parse(row.detail)
        } catch {
          continue
        }
        const parsed = ProjectionSchema.safeParse(detail)
        if (!parsed.success) continue
        // Only the claim items can ever prove a link: keep nothing else of the saved activity.
        const claims = parsed.data.activity
          .filter((item) => item.text === 'claimed')
          .slice(0, 50)
          .map((item) => ({ at: item.at, agentId: item.agentId }))
        for (const legacyId of parsed.data.runIds) {
          if (!/^\d+$/.test(legacyId)) continue
          insert.run(row.id, legacyId, JSON.stringify({ claims }), now)
        }
      }
      sqlite.prepare('INSERT INTO kanban_upgrade_state (id, snapshotted_at) VALUES (1, ?)').run(now)
      return []
    },
  })
}

/**
 * Resolve pending links against a verified, baselined history. A link maps only when a saved "claimed" activity item
 * has the attempt's frozen start second and its frozen claim profile; task id + numeric id alone never maps.
 */
export async function resolveUpgradeLinks(
  db: ScoreDb,
  sink: ObservationSink,
  source: string,
  historyId: string,
): Promise<number> {
  const pending = z.array(LinkRowSchema).parse(
    db.sqlite
      .prepare(
        `SELECT task_id, legacy_id, saved_evidence FROM kanban_upgrade_links
            WHERE status = 'pending' ORDER BY task_id, legacy_id LIMIT ?`,
      )
      .all(UPGRADE_BATCH),
  )
  if (!pending.length) return 0
  await sink.submit({
    source,
    identity: `kanban:upgrade:${randomUUID()}`,
    apply: ({ sqlite, now }) => {
      const history = sqlite
        .prepare('SELECT state, baseline_done FROM kanban_histories WHERE id = ?')
        .get(historyId)
      const live = z.object({ state: z.string(), baseline_done: z.int() }).safeParse(history)
      // Hermes unreadable or the history unverified: links wait, nothing is decided.
      if (!live.success || live.data.state !== 'active' || live.data.baseline_done !== 1) return []
      const resolve = sqlite.prepare(
        `UPDATE kanban_upgrade_links SET status = ?, attempt_key = ?, reason = ?, resolved_at = ?
          WHERE task_id = ? AND legacy_id = ? AND status = 'pending'`,
      )
      for (const link of pending) {
        const attempt = sqlite
          .prepare(
            'SELECT id, profile, started_at FROM kanban_attempts WHERE history_id = ? AND task_id = ? AND attempt_id = ?',
          )
          .get(historyId, link.task_id, Number(link.legacy_id))
        if (attempt === undefined) {
          resolve.run('unresolved', null, 'attempt_not_found', now, link.task_id, link.legacy_id)
          continue
        }
        const proof = AttemptProofSchema.parse(attempt)
        const evidence = SavedEvidenceSchema.safeParse(JSON.parse(link.saved_evidence))
        const startedAt = new Date(proof.started_at * 1000).toISOString()
        const proven =
          evidence.success &&
          proof.profile !== null &&
          evidence.data.claims.some(
            (claim) => claim.at === startedAt && claim.agentId === proof.profile,
          )
        if (proven) resolve.run('mapped', proof.id, null, now, link.task_id, link.legacy_id)
        else
          resolve.run(
            'unresolved',
            null,
            'no_affirmative_evidence',
            now,
            link.task_id,
            link.legacy_id,
          )
      }
      // Receipts that still show the old ids are rewritten in the same transaction (never deleted).
      rewriteReceipts(sqlite, [...new Set(pending.map((link) => link.task_id))])
      return []
    },
  })
  return pending.length
}
