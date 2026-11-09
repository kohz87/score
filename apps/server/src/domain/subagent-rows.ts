import type { DatabaseSync } from 'node:sqlite'
import { SubagentRowSchema, type SubagentRow } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { redactBounded } from '../redact.ts'

// One row per subagent, for the chat's status card and the job map (decision 174). Their steps stay in Watch.

const RowSchema = z.object({
  id: z.string(),
  job_id: z.string(),
  profile: z.string(),
  goal: z.string(),
  state: z.enum(['running', 'done', 'failed']),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  cost_usd: z.number().nullable(),
  tokens: z.int().nullable(),
})

/** Waiting on the person: an approval from this subagent's own session is open. */
const asView = (sqlite: DatabaseSync, row: z.infer<typeof RowSchema>): SubagentRow =>
  SubagentRowSchema.parse({
    id: row.id,
    jobId: row.job_id,
    agentId: row.profile,
    goal: row.goal,
    state: row.state,
    waitingOnYou:
      row.state === 'running' &&
      sqlite
        .prepare("SELECT 1 FROM approvals WHERE hook_session_id = ? AND status = 'pending' LIMIT 1")
        .get(row.id) !== undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    costUsd: row.cost_usd,
    tokens: row.tokens,
  })

const rowEvent = (sqlite: DatabaseSync, id: string): DomainEventDraft[] => {
  const row = sqlite.prepare('SELECT * FROM subagents WHERE id = ?').get(id)
  return row === undefined
    ? []
    : [{ type: 'subagent.upserted', data: asView(sqlite, RowSchema.parse(row)) }]
}

export function startSubagentRow(
  sqlite: DatabaseSync,
  row: { id: string; jobId: string; profile: string; goal: string; now: string },
): DomainEventDraft[] {
  sqlite
    .prepare(
      `INSERT INTO subagents (id, job_id, profile, goal, state, started_at) VALUES (?, ?, ?, ?, 'running', ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(row.id, row.jobId, row.profile, redactBounded(row.goal, 500), row.now)
  return rowEvent(sqlite, row.id)
}

export function endSubagentRow(
  sqlite: DatabaseSync,
  id: string,
  state: 'done' | 'failed',
  now: string,
): DomainEventDraft[] {
  const changed = sqlite
    .prepare("UPDATE subagents SET state = ?, ended_at = ? WHERE id = ? AND state = 'running'")
    .run(state, now, id).changes
  return changed ? rowEvent(sqlite, id) : []
}

/** A run ended before its subagent said so (Stop, a crash): nothing of it is still running. */
export function endRunningSubagentsOf(
  sqlite: DatabaseSync,
  jobId: string,
  profile: string,
  now: string,
): DomainEventDraft[] {
  const running = sqlite
    .prepare("SELECT id FROM subagents WHERE job_id = ? AND profile = ? AND state = 'running'")
    .all(jobId, profile) as { id: string }[]
  return running.flatMap(({ id }) => endSubagentRow(sqlite, id, 'failed', now))
}

export function setSubagentCost(
  sqlite: DatabaseSync,
  id: string,
  usd: number | null,
  tokens: number,
): DomainEventDraft[] {
  const changed = sqlite
    .prepare(
      'UPDATE subagents SET cost_usd = ?, tokens = ? WHERE id = ? AND (cost_usd IS NOT ? OR tokens IS NOT ?)',
    )
    .run(usd, tokens, id, usd, tokens).changes
  return changed ? rowEvent(sqlite, id) : []
}

export function subagentRowsOf(sqlite: DatabaseSync, jobId: string): SubagentRow[] {
  return z
    .array(RowSchema)
    .parse(
      sqlite.prepare('SELECT * FROM subagents WHERE job_id = ? ORDER BY started_at, id').all(jobId),
    )
    .map((row) => asView(sqlite, row))
}

export const isSubagentSession = (sqlite: DatabaseSync, sessionId: string): boolean =>
  sqlite.prepare('SELECT 1 FROM subagents WHERE id = ?').get(sessionId) !== undefined
