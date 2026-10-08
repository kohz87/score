import { randomUUID } from 'node:crypto'
import type { ScoreDb } from '../db/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { expireApprovals } from './approvals.ts'

export async function sweepExpiredApprovals(
  db: ScoreDb,
  ingest: Pick<Ingest, 'submit'>,
  clock = Date.now,
): Promise<void> {
  const at = new Date(clock()).toISOString()
  if (
    !db.sqlite
      .prepare(
        "SELECT 1 FROM approvals WHERE phase IN ('guardian_evaluating', 'human_pending') AND expires_at <= ? LIMIT 1",
      )
      .get(at)
  )
    return
  await ingest.submit({
    source: 'approval-expiry',
    identity: randomUUID(),
    apply: ({ sqlite }) => expireApprovals(sqlite, at),
  })
}
