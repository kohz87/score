import { z } from 'zod'
import { redact, redactBounded } from '../../redact.ts'
import {
  AUTOMATION_SOURCES,
  BUSY_WINDOW_MS,
  MAX_IMPORT_MESSAGES,
  MAX_IMPORT_TEXT_BYTES,
  sourceLabel,
  type OutsideSessionFact,
  type OutsideSessionHistory,
} from '../outside-sessions.ts'
import { hermesPaths, ProfileNameSchema, resolveHermesHome } from './paths.ts'
import { HermesDbMissing, HermesSchemaDrift, openReadOnly, readBatch } from './sqlite.ts'

const SessionRowSchema = z.object({
  id: z.string(),
  source: z.string(),
  title: z.string().nullable(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  message_count: z.int().nullable(),
  last_activity_at: z.number().nullable(),
})
const FirstMessageSchema = z.object({ content: z.string().nullable() })
const MessageRowSchema = z.object({
  id: z.int().positive(),
  role: z.string(),
  content: z.string().nullable(),
  timestamp: z.number(),
})

const MAX_LISTED = 200
const TITLE_CHARS = 120

function fact(
  agentId: string,
  row: z.infer<typeof SessionRowSchema>,
  title: string,
  nowMs: number,
): OutsideSessionFact {
  const lastMs = (row.last_activity_at ?? row.ended_at ?? row.started_at) * 1000
  return {
    id: row.id,
    agentId,
    source: row.source,
    sourceLabel: sourceLabel(row.source),
    title,
    startedAt: new Date(row.started_at * 1000).toISOString(),
    messageCount: row.message_count ?? 0,
    busy: row.ended_at === null && nowMs - lastMs < BUSY_WINDOW_MS,
  }
}

function cut(text: string, chars: number): string {
  const flat = redact(text).replace(/\s+/g, ' ').trim()
  return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat
}

const excluded = AUTOMATION_SOURCES.map((source) => `'${source}'`).join(', ')
const SESSION_FILTER = `WHERE parent_session_id IS NULL AND COALESCE(message_count, 0) > 0
  AND source NOT IN (${excluded}) AND NOT (source = 'api_server' AND id LIKE 'score-%')`

/** Read-only: each profile's own state.db. A missing database or a changed schema marks the profile unavailable. */
export function listOutsideSessions(
  agentIds: string[],
  hermesHome: string | undefined,
  nowMs = Date.now(),
): { items: OutsideSessionFact[]; unavailable: string[] } {
  const paths = hermesPaths(resolveHermesHome(hermesHome))
  const items: OutsideSessionFact[] = []
  const unavailable: string[] = []
  for (const agentId of agentIds) {
    if (!ProfileNameSchema.safeParse(agentId).success) continue
    try {
      const db = openReadOnly(paths.stateDb(agentId))
      try {
        const batch = readBatch(
          db,
          'sessions',
          SessionRowSchema.extend({ parent_session_id: z.string().nullable() }),
          `${SESSION_FILTER} ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT ${MAX_LISTED}`,
          [],
        )
        for (const row of batch.rows) {
          let title = row.title?.trim() ? cut(row.title, TITLE_CHARS) : ''
          if (!title) {
            const first = readBatch(
              db,
              'messages',
              FirstMessageSchema,
              "WHERE session_id = ? AND role = 'user' AND content IS NOT NULL ORDER BY id LIMIT 1",
              [row.id],
            ).rows[0]
            title = first?.content ? cut(first.content, TITLE_CHARS) : ''
          }
          items.push(fact(agentId, row, title, nowMs))
        }
      } finally {
        db.close()
      }
    } catch (error) {
      if (error instanceof HermesDbMissing || error instanceof HermesSchemaDrift)
        unavailable.push(agentId)
      else throw error
    }
  }
  items.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return { items, unavailable }
}

/** One session's user and assistant text, oldest first. Null when the session does not exist (or is not a conversation). */
export function readOutsideSession(
  agentId: string,
  sessionId: string,
  hermesHome: string | undefined,
  nowMs = Date.now(),
): OutsideSessionHistory | null {
  if (!ProfileNameSchema.safeParse(agentId).success) return null
  const paths = hermesPaths(resolveHermesHome(hermesHome))
  let db
  try {
    db = openReadOnly(paths.stateDb(agentId))
  } catch (error) {
    if (error instanceof HermesDbMissing) return null
    throw error
  }
  try {
    const row = readBatch(
      db,
      'sessions',
      SessionRowSchema.extend({ parent_session_id: z.string().nullable() }),
      `${SESSION_FILTER} AND id = ?`,
      [sessionId],
    ).rows[0]
    if (!row) return null
    const rows = readBatch(
      db,
      'messages',
      MessageRowSchema,
      `WHERE session_id = ? AND role IN ('user', 'assistant') AND content IS NOT NULL AND TRIM(content) != ''
       ORDER BY id LIMIT ${MAX_IMPORT_MESSAGES}`,
      [sessionId],
    ).rows
    const messages = rows.map((message) => ({
      role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
      text: redactBounded(message.content ?? '', MAX_IMPORT_TEXT_BYTES),
      at: new Date(message.timestamp * 1000).toISOString(),
    }))
    const first = messages.find((message) => message.role === 'user')
    const title = row.title?.trim()
      ? cut(row.title, TITLE_CHARS)
      : first
        ? cut(first.text, TITLE_CHARS)
        : ''
    return { session: fact(agentId, row, title, nowMs), messages }
  } catch (error) {
    if (error instanceof HermesSchemaDrift) return null
    throw error
  } finally {
    db.close()
  }
}
