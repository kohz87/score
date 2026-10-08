import {
  AgentDetailSchema,
  AgentHistoryPageSchema,
  HistoryOutcomeSchema,
  RunSummarySchema,
  type AgentHistoryItem,
  type HistoryOutcome,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'

export const HISTORY_PAGE_SIZE = 50
const NoNul = (value: string) => !value.includes('\0')
const ParamsSchema = z.object({ agentId: z.string().min(1).max(256) })
const QuerySchema = z.object({
  q: z.string().refine(NoNul).max(200).optional(),
  outcome: HistoryOutcomeSchema.optional(),
  cursor: z
    .string()
    .regex(/^\d{1,6}$/)
    .optional(),
})

const statusesByOutcome: Record<HistoryOutcome, string[]> = {
  completed: ['completed'],
  failed: ['failed'],
  stopped: ['cancelled', 'interrupted'],
  waiting: ['waiting_for_approval'],
  running: ['queued', 'running'],
}
function outcomeOf(status: string): HistoryOutcome {
  for (const [outcome, statuses] of Object.entries(statusesByOutcome))
    if (statuses.includes(status)) return outcome as HistoryOutcome
  return 'running'
}

const RowSchema = z.object({
  id: z.string().min(1),
  origin: RunSummarySchema.shape.origin,
  status: z.string(),
  model: z.string().nullable(),
  started_at: z.iso.datetime(),
  ended_at: z.iso.datetime().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  task_id: z.string().nullable(),
  task_title: z.string().nullable(),
  brief_id: z.string().nullable(),
  brief_title: z.string().nullable(),
  replay_seq: z.int().positive().nullable(),
})
const originTitles = {
  score: 'Chat run',
  kanban: 'Task run',
  gateway: 'Messaging run',
  cron: 'Routine run',
} as const

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

// History is Score's own record of runs (all origins), so it needs no Hermes access: Hermes data never leaves the adapter.
export function registerAgentHistoryRoutes(
  app: FastifyInstance,
  deps: { port: HermesPort; db: ScoreDb },
): void {
  const { port, db } = deps
  app.get('/api/agents/:agentId/history', async (request) => {
    const { agentId } = ParamsSchema.parse(request.params)
    const query = QuerySchema.parse(request.query)
    const known = z.array(AgentDetailSchema).parse(await port.listAgentDetails())
    if (!known.some((agent) => agent.id === agentId))
      throw new HttpError(404, 'not_found', 'Agent not found')
    const filters: string[] = []
    const args: (string | number)[] = [agentId]
    if (query.outcome) {
      const statuses = statusesByOutcome[query.outcome]
      filters.push(`status IN (${statuses.map(() => '?').join(', ')})`)
      args.push(...statuses)
    }
    const needle = query.q?.trim()
    if (needle) {
      filters.push(
        `(COALESCE(task_title, '') || ' ' || COALESCE(brief_title, '') || ' ' || COALESCE(model, '')) LIKE ? ESCAPE '\\'`,
      )
      args.push(`%${escapeLike(needle)}%`)
    }
    const offset = Number(query.cursor ?? 0)
    const rows = db.sqlite
      .prepare(
        `SELECT * FROM (
           SELECT r.id, r.origin, r.status, r.model, r.started_at, r.ended_at, r.cost_usd,
             (SELECT t.id FROM task_projections t, json_each(t.detail, '$.runIds') j WHERE j.value = r.id LIMIT 1) AS task_id,
             (SELECT json_extract(t.detail, '$.title') FROM task_projections t, json_each(t.detail, '$.runIds') j WHERE j.value = r.id LIMIT 1) AS task_title,
             b.id AS brief_id, b.title AS brief_title,
             (SELECT MIN(f.seq) FROM watch_frames f WHERE f.agent_id = r.profile AND f.run_id = r.id) AS replay_seq
           FROM runs r
           LEFT JOIN message_runs mr ON mr.run_id = r.id
           LEFT JOIN briefs b ON b.id = mr.chain_id
           WHERE r.profile = ?
         ) ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
         ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, HISTORY_PAGE_SIZE + 1, offset)
    const parsed = z.array(RowSchema).parse(rows)
    const items: AgentHistoryItem[] = parsed.slice(0, HISTORY_PAGE_SIZE).map((row) => {
      const ended = row.ended_at ? Date.parse(row.ended_at) : null
      return {
        runId: row.id,
        title: row.task_title ?? row.brief_title ?? originTitles[row.origin],
        origin: row.origin,
        outcome: outcomeOf(row.status),
        startedAt: row.started_at,
        durationSec:
          ended === null
            ? null
            : Math.max(0, Math.round((ended - Date.parse(row.started_at)) / 1000)),
        model: row.model,
        costUsd: row.cost_usd,
        task: row.task_id ? { id: row.task_id, title: row.task_title ?? row.task_id } : null,
        brief: row.brief_id ? { id: row.brief_id, title: row.brief_title ?? row.brief_id } : null,
        replaySeq: row.replay_seq,
      }
    })
    return AgentHistoryPageSchema.parse({
      items,
      nextCursor: parsed.length > HISTORY_PAGE_SIZE ? String(offset + HISTORY_PAGE_SIZE) : null,
    })
  })
}
