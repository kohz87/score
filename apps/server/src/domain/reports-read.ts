import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { kanbanAttemptsEnabled, listAttempts } from './kanban-attempts.ts'
import type { ReportApproval, ReportAttempt, ReportRun } from './reports-types.ts'

const RunRowSchema = z.object({
  profile: z.string(),
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
})
const ApprovalReportRowSchema = z.object({
  profile: z.string(),
  stage: z.enum(['guardian', 'human']),
  visible: z.int(),
  status: z.string(),
  decision_by: z.string().nullable(),
  created_at: z.iso.datetime(),
  decided_at: z.iso.datetime().nullable(),
  closed_at: z.iso.datetime().nullable(),
})

/** Runs and approvals that overlap the window (so open intervals that started earlier still count). */
export function readReportRows(
  sqlite: DatabaseSync,
  from: number,
  to: number,
  withAttempts = kanbanAttemptsEnabled(),
): { runs: ReportRun[]; approvals: ReportApproval[]; attempts?: ReportAttempt[] } {
  const fromIso = new Date(from).toISOString()
  const toIso = new Date(to).toISOString()
  const runs = sqlite
    .prepare(
      `SELECT profile, started_at, ended_at FROM runs
       WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`,
    )
    .all(toIso, fromIso)
    .map((row) => RunRowSchema.parse(row))
    .map((row) => ({ agentId: row.profile, startedAt: row.started_at, endedAt: row.ended_at }))
  const approvals = sqlite
    .prepare(
      `SELECT profile, stage, visible, status, decision_by, created_at, decided_at, closed_at FROM approvals
       WHERE created_at <= ? AND (COALESCE(decided_at, closed_at) IS NULL OR COALESCE(decided_at, closed_at) >= ?)`,
    )
    .all(toIso, fromIso)
    .map((row) => ApprovalReportRowSchema.parse(row))
    .map((row) => ({
      agentId: row.profile,
      stage: row.stage,
      visible: row.visible === 1,
      status: row.status,
      decisionBy: row.decision_by,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      closedAt: row.closed_at,
    }))
  if (!withAttempts) return { runs, approvals }
  const attempts = listAttempts(sqlite, { since: fromIso, until: toIso, excludeCopies: true }).map(
    (attempt): ReportAttempt => ({
      agentId: attempt.agentId,
      startedAt: attempt.startedAt,
      endedAt: attempt.endedAt ?? attempt.observationEndedAt,
      evidence: attempt.evidence,
      observed: attempt.observations,
    }),
  )
  return { runs, approvals, attempts }
}
