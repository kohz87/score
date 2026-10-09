import {
  AgentHistoryPageSchema,
  AgentSummarySchema,
  HistoryOutcomeSchema,
  RunSummarySchema,
  type AgentHistoryItem,
  type HistoryOutcome,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import {
  attemptSummary,
  kanbanAttemptsEnabled,
  listAttempts,
  type KanbanAttempt,
} from '../domain/kanban-attempts.ts'
import { readProjectedTask } from '../domain/tasks.ts'
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

// 'interrupted' (a reclaimed attempt) does not prove the worker stopped, and an unrecognised status is not
// "running": both get their own honest outcome. `unknown` is every status not listed here.
const statusesByOutcome: Record<Exclude<HistoryOutcome, 'unknown'>, string[]> = {
  completed: ['completed'],
  failed: ['failed'],
  stopped: ['cancelled'],
  interrupted: ['interrupted'],
  waiting: ['waiting_for_approval'],
  running: ['queued', 'running'],
}
const knownStatuses = Object.values(statusesByOutcome).flat()
function outcomeOf(status: string): HistoryOutcome {
  for (const [outcome, statuses] of Object.entries(statusesByOutcome))
    if (statuses.includes(status)) return outcome as HistoryOutcome
  return 'unknown'
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

// Kanban attempts (5.17a-1): a normal finish is a completed outcome, even when it hands the task on; a blocked,
// unobserved or unknown ending is not guessed into one.
function attemptOutcome(attempt: KanbanAttempt): HistoryOutcome {
  if (attempt.status === 'running')
    return attempt.observationEndedAt === null ? 'running' : 'unknown'
  if (['completed', 'review_handoff', 'changes_requested'].includes(attempt.status))
    return 'completed'
  return attempt.status === 'failed' ? 'failed' : 'unknown'
}

function attemptItems(
  sqlite: DatabaseSync,
  agentId: string,
  query: z.infer<typeof QuerySchema>,
): { item: AgentHistoryItem; startedAt: string; id: string }[] {
  const needle = query.q?.trim().toLowerCase()
  return listAttempts(sqlite, {
    since: new Date(0).toISOString(),
    until: new Date(Date.now() + 86_400_000).toISOString(),
    agentId,
    excludeCopies: true,
  }).flatMap((attempt) => {
    const outcome = attemptOutcome(attempt)
    if (query.outcome && query.outcome !== outcome) return []
    const summary = attemptSummary(attempt)
    const title =
      (summary.task.current ? readProjectedTask(sqlite, attempt.taskId)?.title : undefined) ??
      attempt.taskSnapshot?.title ??
      originTitles.kanban
    const brief = summary.task.current
      ? ((sqlite
          .prepare(
            `SELECT b.id, b.title FROM brief_tasks bt JOIN briefs b ON b.id = bt.brief_id
              WHERE bt.task_id = ? ORDER BY bt.linked_at LIMIT 1`,
          )
          .get(attempt.taskId) as { id: string; title: string } | undefined) ?? null)
      : null
    if (needle && !`${title} ${brief?.title ?? ''}`.toLowerCase().includes(needle)) return []
    const end = attempt.endedAt ?? attempt.observationEndedAt
    return [
      {
        startedAt: attempt.startedAt,
        id: attempt.id,
        item: {
          runId: attempt.id,
          title,
          origin: 'kanban' as const,
          outcome,
          startedAt: attempt.startedAt,
          durationSec:
            end === null
              ? null
              : Math.max(0, Math.round((Date.parse(end) - Date.parse(attempt.startedAt)) / 1000)),
          model: null,
          costUsd: null,
          // A task from an earlier copy of the board is not linked: the row opens its attempt detail instead.
          task: summary.task.current ? { id: attempt.taskId, title } : null,
          brief: brief ? { id: brief.id, title: brief.title } : null,
          replaySeq: null,
          attempt: summary,
        },
      },
    ]
  })
}

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
    // The summary list, not listAgentDetails: the tab refetches every 10 s and details spawn Hermes processes.
    const known = z.array(AgentSummarySchema).parse(await port.listAgents())
    // A deleted agent leaves the Hermes roster but its retained runs stay readable while Score still lists it.
    const retained = db.sqlite
      .prepare('SELECT 1 FROM agent_lifecycle WHERE agent_id = ?')
      .get(agentId)
    if (!retained && !known.some((agent) => agent.id === agentId))
      throw new HttpError(404, 'not_found', 'Agent not found')
    const filters: string[] = []
    const args: (string | number)[] = [agentId]
    if (query.outcome) {
      const statuses =
        query.outcome === 'unknown' ? knownStatuses : statusesByOutcome[query.outcome]
      filters.push(
        `status ${query.outcome === 'unknown' ? 'NOT IN' : 'IN'} (${statuses.map(() => '?').join(', ')})`,
      )
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
    // With attempts on, runs and attempts are merged before paging, so runs are read from the top.
    const withAttempts = kanbanAttemptsEnabled()
    const attemptsOffset = withAttempts ? offset : 0
    const rows = db.sqlite
      .prepare(
        `SELECT * FROM (
           SELECT r.id, r.origin, r.status, r.model, r.started_at, r.ended_at, r.cost_usd,
             (SELECT t.id FROM task_projections t, json_each(t.detail, '$.runIds') j WHERE j.value = r.id LIMIT 1) AS task_id,
             (SELECT json_extract(t.detail, '$.title') FROM task_projections t, json_each(t.detail, '$.runIds') j WHERE j.value = r.id LIMIT 1) AS task_title,
             b.id AS brief_id, b.title AS brief_title,
             (SELECT MIN(f.seq) FROM watch_frames f WHERE f.agent_id = r.profile AND f.run_id = r.id) AS replay_seq
           FROM runs r
           LEFT JOIN briefs b ON b.id = COALESCE(
             (SELECT mr.chain_id FROM message_runs mr WHERE mr.run_id = r.id LIMIT 1),
             -- A Kanban run has no message; its brief is the one that linked its task.
             (SELECT bt.brief_id FROM brief_tasks bt
                WHERE bt.task_id = (SELECT t.id FROM task_projections t, json_each(t.detail, '$.runIds') j WHERE j.value = r.id LIMIT 1)
                ORDER BY bt.linked_at LIMIT 1))
           WHERE r.profile = ?
         ) ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
         ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, HISTORY_PAGE_SIZE + 1 + attemptsOffset, offset - attemptsOffset)
    const parsed = z.array(RowSchema).parse(rows)
    const runItems: AgentHistoryItem[] = parsed.map((row) => {
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
    if (!withAttempts)
      return AgentHistoryPageSchema.parse({
        items: runItems.slice(0, HISTORY_PAGE_SIZE),
        nextCursor: parsed.length > HISTORY_PAGE_SIZE ? String(offset + HISTORY_PAGE_SIZE) : null,
      })
    const merged = [
      ...runItems.map((item) => ({ item, startedAt: item.startedAt, id: item.runId })),
      ...db.read((sqlite) => attemptItems(sqlite, agentId, query)),
    ].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || (a.id < b.id ? 1 : -1))
    return AgentHistoryPageSchema.parse({
      items: merged.slice(offset, offset + HISTORY_PAGE_SIZE).map(({ item }) => item),
      nextCursor:
        merged.length > offset + HISTORY_PAGE_SIZE ? String(offset + HISTORY_PAGE_SIZE) : null,
    })
  })
}
