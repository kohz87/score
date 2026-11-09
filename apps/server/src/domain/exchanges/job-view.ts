import type { DatabaseSync } from 'node:sqlite'
import { JobSchema, JobSourceSchema, type Job } from '@score/contract'
import { z } from 'zod'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { redact } from '../../redact.ts'
import { reportBackOf } from '../triggers/report-back.ts'
import { jobRow } from './row-reads.ts'
import type { JobRow } from './row-schemas.ts'

/** What lists show about a job besides its row (PLAN 11.2): unread, who is busy, last activity, a one-line summary. */
export function jobFromRow(sqlite: DatabaseSync, row: JobRow): Job {
  const counts = sqlite
    .prepare(
      `SELECT count(*) AS n, MAX(m.created_at) AS last,
         SUM(m.author_kind = 'agent' AND (r.job_id IS NULL
           OR (m.created_at, m.id) > (r.last_read_message_created_at, r.last_read_message_id))) AS unread
       FROM messages m LEFT JOIN job_reads r ON r.job_id = m.job_id
       WHERE m.job_id = ? AND m.deleted_at IS NULL`,
    )
    .get(row.id) as { n: number; last: string | null; unread: number | null }
  const busy = sqlite
    .prepare(
      "SELECT DISTINCT agent_id FROM message_runs WHERE job_id = ? AND state = 'active' AND purpose IS NULL ORDER BY agent_id",
    )
    .all(row.id) as { agent_id: string }[]
  const reportBack = row.source === null ? null : reportBackOf(sqlite, row.id)
  return JobSchema.parse({
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    state: row.state,
    holderAgentId: row.holder_agent_id,
    isDefault: row.is_default === 1,
    exchangeBudget: row.exchange_budget,
    jobTurnLimit: row.job_turn_limit,
    spendCapUsd: row.spend_cap_usd,
    subagents: {
      enabled: row.subagents_enabled === 1,
      maxConcurrent: row.subagents_max_concurrent,
      maxTotal: row.subagents_max_total,
      used: row.subagents_used,
    },
    recipe:
      row.recipe_kind && row.recipe_ref ? { kind: row.recipe_kind, ref: row.recipe_ref } : null,
    unread: counts.unread ?? 0,
    activeAgents: busy.map((agent) => agent.agent_id),
    lastMessageAt: counts.last,
    messageCount: counts.n,
    summary: jobSummaryLine(sqlite, row),
    source: row.source === null ? null : JobSourceSchema.parse(JSON.parse(row.source)),
    reportBack,
    needsYou:
      Boolean(
        sqlite
          .prepare(
            `SELECT 1 FROM exchanges WHERE job_id = ? AND pause_reason IS NOT NULL
               AND state IN ('paused_budget', 'waiting_on_you') LIMIT 1`,
          )
          .get(row.id),
      ) ||
      reportBack?.state === 'needs_ok' ||
      reportBack?.state === 'not_confirmed',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

const SUMMARY_LINE = 160
/** The job's summary (its newest visible one), else the first line of its first message, redacted and bounded. */
function jobSummaryLine(sqlite: DatabaseSync, row: JobRow): string | null {
  // A cheap text match first, so a job without summaries never has every message's parts parsed.
  const isSummary = `parts LIKE '%"kind":"summary"%' AND EXISTS (SELECT 1 FROM json_each(messages.parts)
       WHERE json_extract(value, '$.kind') = 'summary' AND COALESCE(json_extract(value, '$.stale'), 0) = 0)`
  const visible = 'job_id = ? AND deleted_at IS NULL AND streaming = 0'
  const found = (sqlite
    .prepare(
      `SELECT parts FROM messages WHERE ${visible} AND ${isSummary} ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(row.id) ??
    sqlite
      .prepare(`SELECT parts FROM messages WHERE ${visible} ORDER BY created_at, id LIMIT 1`)
      .get(row.id)) as { parts: string } | undefined
  if (!found) return null
  const parts = z
    .array(z.object({ kind: z.string(), text: z.string().optional() }).loose())
    .parse(JSON.parse(found.parts))
  const text = parts.find((part) => part.kind === 'summary' || part.kind === 'text')?.text
  const line = text
    ?.split('\n')
    .find((piece) => piece.trim())
    ?.trim()
  if (!line) return null
  const clean = redact(line)
  return clean.length > SUMMARY_LINE ? `${clean.slice(0, SUMMARY_LINE - 1)}…` : clean
}

/**
 * `job.upserted` for a job the new shell shows. A room still on @mentions (an orchestration or workflow run's, since
 * 11.11) has its one default job and the classic shell reads it as a room, so its jobs send nothing.
 */
export const jobEvent = (sqlite: DatabaseSync, jobId: string): DomainEventDraft[] => {
  const row = jobRow(sqlite, jobId)
  if (!row) return []
  const room = sqlite.prepare('SELECT role, routing FROM rooms WHERE id = ?').get(row.room_id) as
    { role: string; routing: string } | undefined
  if (room?.role === 'room' && room.routing === 'mentions') return []
  // A deleted job was announced as gone (`job.deleted`); nothing brings it back but its restore.
  const deleted = sqlite.prepare('SELECT deleted_at FROM jobs WHERE id = ?').get(jobId) as
    { deleted_at: string | null } | undefined
  if (deleted?.deleted_at) return []
  return [{ type: 'job.upserted', data: jobFromRow(sqlite, row) }]
}
