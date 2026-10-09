import { z } from 'zod'
import type { CacheTokens, KanbanTaskFact, ReportFacts } from '../../domain/reports.ts'
import { hermesPaths, ProfileNameSchema, resolveHermesHome } from './paths.ts'
import { HermesDbMissing, HermesSchemaDrift, openReadOnly, readBatch } from './sqlite.ts'
import type { SessionCost } from '../../domain/spend.ts'
import { readSessionCosts, sessionCacheTokens, sessionSpend } from './sessions.ts'

const TaskRowSchema = z.object({
  id: z.string(),
  assignee: z.string().nullable(),
  status: z.string(),
  created_at: z.number(),
  completed_at: z.number().nullable(),
})
const LinkRowSchema = z.object({ child_id: z.string() })
const EventRowSchema = z.object({
  id: z.int().positive(),
  task_id: z.string(),
  kind: z.string(),
  created_at: z.number(),
  payload: z.string().nullable(),
})
const ImplementerSchema = z.object({ implementer: z.string().trim().min(1) })
// The implementer named on a review event is the profile that waits for (or receives) the review.
function actorOf(payload: string | null): string | null {
  if (payload === null) return null
  try {
    const parsed = ImplementerSchema.safeParse(JSON.parse(payload))
    return parsed.success ? parsed.data.implementer : null
  } catch {
    return null
  }
}
const EVENT_KINDS = [
  'review_requested',
  'changes_requested',
  'completed',
  'promoted',
  'blocked',
  'unblocked',
]

/** Read-only: spend comes from each profile's own state.db; send-backs from kanban.db. Missing data is null/empty. */
export function readReportFacts(
  req: { from: number; to: number; agentIds: string[] },
  hermesHome?: string,
): ReportFacts {
  const paths = hermesPaths(resolveHermesHome(hermesHome))
  const spendUsd: Record<string, number | null> = {}
  const cache: Record<string, CacheTokens | null> = {}
  for (const agentId of req.agentIds) {
    spendUsd[agentId] = null
    cache[agentId] = null
    if (!ProfileNameSchema.safeParse(agentId).success) continue
    try {
      const db = openReadOnly(paths.stateDb(agentId))
      try {
        spendUsd[agentId] = sessionSpend(db, req.from / 1000, req.to / 1000)
        cache[agentId] = sessionCacheTokens(db, req.from / 1000, req.to / 1000)
      } finally {
        db.close()
      }
    } catch (error) {
      if (!(error instanceof HermesDbMissing || error instanceof HermesSchemaDrift)) throw error
    }
  }
  let tasks: KanbanTaskFact[] = []
  try {
    const db = openReadOnly(paths.kanbanDb)
    try {
      const children = new Set(
        readBatch(db, 'task_links', LinkRowSchema, '', []).rows.map((row) => row.child_id),
      )
      const events = Map.groupBy(
        readBatch(
          db,
          'task_events',
          EventRowSchema,
          `WHERE kind IN (${EVENT_KINDS.map(() => '?').join(', ')}) ORDER BY id`,
          EVENT_KINDS,
        ).rows,
        (row) => row.task_id,
      )
      tasks = readBatch(db, 'tasks', TaskRowSchema, 'ORDER BY rowid', []).rows.map((row) => ({
        id: row.id,
        assignee: row.assignee,
        status: row.status,
        createdAt: row.created_at * 1000,
        completedAt: row.completed_at === null ? null : row.completed_at * 1000,
        hasParents: children.has(row.id),
        events: (events.get(row.id) ?? []).map((event) => ({
          id: event.id,
          kind: event.kind,
          at: event.created_at * 1000,
          actor: actorOf(event.payload),
        })),
      }))
    } finally {
      db.close()
    }
  } catch (error) {
    if (!(error instanceof HermesDbMissing || error instanceof HermesSchemaDrift)) throw error
  }
  return { tasks, spendUsd, cache }
}

/** Read-only: per profile, the sessions active since `sinceMs` with their cumulative cost. Unreadable profiles are omitted. */
export function readProfileSessionCosts(
  req: { sinceMs: number; agentIds: string[] },
  hermesHome?: string,
): Record<string, SessionCost[]> {
  const paths = hermesPaths(resolveHermesHome(hermesHome))
  const result: Record<string, SessionCost[]> = {}
  for (const agentId of req.agentIds) {
    if (!ProfileNameSchema.safeParse(agentId).success) continue
    try {
      const db = openReadOnly(paths.stateDb(agentId))
      try {
        const sessions = readSessionCosts(db, req.sinceMs / 1000)
        if (sessions) result[agentId] = sessions
      } finally {
        db.close()
      }
    } catch (error) {
      if (!(error instanceof HermesDbMissing || error instanceof HermesSchemaDrift)) throw error
    }
  }
  return result
}
