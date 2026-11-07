import type { DatabaseSync } from 'node:sqlite'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import { addStored, utf8Bytes } from './ops-storage.ts'
import {
  refuseAttempt,
  retireQueued,
  setStepStatus,
  withdrawGates,
  withdrawInquiries,
} from './ops-steps.ts'
import { addHistory, attemptsOf, isFinalStep, readStep, type OrchRow } from './store.ts'

/**
 * Finish request: an admission barrier in one transaction. No further admission, queued work retired with a
 * disposition, open gates and inquiries withdrawn, further commands sealed; admitted attempts drain. Shared by the
 * lead's `orch.finish` and the workflow planner (attemptId null).
 */
export function beginFinish(
  ctx: Ctx,
  o: OrchRow,
  attemptId: string | null,
  outcome: 'success' | 'partial' | 'failed',
  summary: string,
): string[] {
  const { sqlite, now } = ctx
  sqlite
    .prepare(
      `UPDATE orchestrations SET status = 'finishing', pause_reason = NULL, finish_requested_at = ?, finish_attempt_id = ?, finish_outcome = ?, finish_summary = ? WHERE id = ?`,
    )
    .run(now, attemptId, outcome, summary, o.id)
  const retired = retireQueued(sqlite, o.id, 'not_started: run_finishing', now)
  withdrawGates(sqlite, o.id, now)
  withdrawInquiries(sqlite, o.id, now)
  for (const created of attemptsOf(sqlite, o.id).filter((a) => a.state === 'created')) {
    refuseAttempt(sqlite, created, 'not dispatched: run finishing', now)
    // A step that is already final (a coding worker's blocked step waiting with its suspended attempt) keeps its own
    // status and reason; only waiting work becomes "not started".
    const step = created.step_id ? readStep(sqlite, o.id, created.step_id) : undefined
    if (created.step_id && (!step || !isFinalStep(step.status)))
      setStepStatus(sqlite, o.id, created.step_id, 'not_started', 'not_started: run_finishing', now)
  }
  addStored(sqlite, o.id, utf8Bytes(summary))
  addHistory(sqlite, o.id, 'finish_requested', { outcome, attemptId, retired }, now)
  journalSoft(ctx, () =>
    ctx.journal.append({ kind: 'transition', orchestrationId: o.id, what: 'finish' }),
  )
  touch(ctx, o.id)
  return retired
}

const CONTROL_KINDS = ['paused', 'resumed', 'limits_changed']

/**
 * v8.1 item 5: control history is bounded (200 records per run). Older pause / resume / limits records fold into one
 * counter row; the journaled transitions (finish, waiver, abandon, ...) are different kinds and are never compacted.
 */
export function compactControlHistory(sqlite: DatabaseSync, orchId: string, limit = 200): void {
  const marks = CONTROL_KINDS.map(() => '?').join(',')
  const count = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM orc_history WHERE orchestration_id = ? AND kind IN (${marks})`,
      )
      .get(orchId, ...CONTROL_KINDS) as { n: number }
  ).n
  if (count <= limit) return
  const extra = count - limit
  sqlite
    .prepare(
      `DELETE FROM orc_history WHERE id IN (SELECT id FROM orc_history WHERE orchestration_id = ? AND kind IN (${marks}) ORDER BY id LIMIT ?)`,
    )
    .run(orchId, ...CONTROL_KINDS, extra)
  const row = sqlite
    .prepare(
      "SELECT id, detail FROM orc_history WHERE orchestration_id = ? AND kind = 'compacted_control'",
    )
    .get(orchId) as { id: number; detail: string } | undefined
  if (row)
    sqlite
      .prepare('UPDATE orc_history SET detail = ? WHERE id = ?')
      .run(
        JSON.stringify({ count: (JSON.parse(row.detail) as { count: number }).count + extra }),
        row.id,
      )
  else
    sqlite
      .prepare(
        "INSERT INTO orc_history (orchestration_id, kind, detail, at) VALUES (?, 'compacted_control', ?, ?)",
      )
      .run(orchId, JSON.stringify({ count: extra }), new Date().toISOString())
}
